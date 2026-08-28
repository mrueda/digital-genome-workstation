use crate::error::{DgwError, Result};
use crate::model::{
    EvaluationResult, EvidenceResult, EvidenceStatus, IndexedResource, ResourceBundle, VariantKey,
};
use crate::project::Project;
use crate::vcf::parse_info;
use chrono::Utc;
use flate2::read::MultiGzDecoder;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tempfile::NamedTempFile;
use uuid::Uuid;

pub fn evaluation_cache_key(variant: &VariantKey, bundle_fingerprint: &str) -> String {
    let value = format!(
        "dgw-eval-v1|{}|{}",
        variant.stable_key(),
        bundle_fingerprint
    );
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub struct EvaluationService {
    worker: Mutex<Option<SnpeffWorker>>,
}

impl Default for EvaluationService {
    fn default() -> Self {
        Self::new()
    }
}

impl EvaluationService {
    pub fn new() -> Self {
        Self {
            worker: Mutex::new(None),
        }
    }

    pub fn evaluate(&self, project: &Project, variant: &VariantKey) -> Result<EvaluationResult> {
        let cache_key =
            evaluation_cache_key(variant, &project.manifest().resource_bundle_fingerprint);
        if let Some(result) = project.cache_get(&cache_key)? {
            return Ok(result);
        }

        let snpeff = self.evaluate_device(project, variant, "org.dgw.builtin.snpeff")?;
        let dbnsfp = self.evaluate_device(project, variant, "org.dgw.builtin.dbnsfp")?;
        let clinvar = self.evaluate_device(project, variant, "org.dgw.builtin.clinvar")?;
        let cosmic = self.evaluate_device(project, variant, "org.dgw.builtin.cosmic")?;
        let result = EvaluationResult {
            variant: variant.clone(),
            cache_key,
            snpeff,
            dbnsfp,
            clinvar,
            cosmic,
            evaluated_at: Utc::now(),
            resource_bundle_fingerprint: project.manifest().resource_bundle_fingerprint.clone(),
            limitation: "Consequences are evaluated independently per variant; compound haplotype-aware transcript consequences are not computed in DGW v1.".into(),
        };
        let durable = [
            &result.snpeff,
            &result.dbnsfp,
            &result.clinvar,
            &result.cosmic,
        ]
        .iter()
        .all(|evidence| {
            !matches!(
                evidence.status,
                EvidenceStatus::Error | EvidenceStatus::ResourceUnavailable
            )
        });
        if durable {
            project.cache_put(&result)?;
        }
        Ok(result)
    }

    /// Runs one built-in allele-analysis device without invoking the rest of the rack.
    pub fn evaluate_device(
        &self,
        project: &Project,
        variant: &VariantKey,
        device_id: &str,
    ) -> Result<EvidenceResult> {
        let bundle = &project.manifest().resource_bundle;
        let result = match device_id {
            "org.dgw.builtin.snpeff" => match self.annotate_snpeff(
                bundle,
                &project.manifest().resource_bundle_fingerprint,
                variant,
            ) {
                Ok(records) => EvidenceResult {
                    source: "SnpEff".into(),
                    status: if records.is_empty() {
                        EvidenceStatus::NoExactMatch
                    } else {
                        EvidenceStatus::Found
                    },
                    records,
                    message: None,
                },
                Err(error) => EvidenceResult {
                    source: "SnpEff".into(),
                    status: EvidenceStatus::Error,
                    records: Vec::new(),
                    message: Some(error.to_string()),
                },
            },
            "org.dgw.builtin.dbnsfp" => query_resource(
                &bundle.tabix_path,
                &bundle.dbnsfp,
                variant,
                ResourceKind::Dbnsfp,
            ),
            "org.dgw.builtin.clinvar" => query_resource(
                &bundle.tabix_path,
                &bundle.clinvar,
                variant,
                ResourceKind::Vcf,
            ),
            "org.dgw.builtin.cosmic" => query_resource(
                &bundle.tabix_path,
                &bundle.cosmic,
                variant,
                ResourceKind::Vcf,
            ),
            _ => {
                return Err(DgwError::InvalidDevice(format!(
                    "device {device_id} cannot evaluate a selected allele"
                )))
            }
        };
        Ok(result)
    }

    fn annotate_snpeff(
        &self,
        bundle: &ResourceBundle,
        bundle_fingerprint: &str,
        variant: &VariantKey,
    ) -> Result<Vec<BTreeMap<String, String>>> {
        let mut guard = self
            .worker
            .lock()
            .map_err(|_| DgwError::Tool("SnpEff worker lock is poisoned".into()))?;
        let needs_worker = guard
            .as_ref()
            .is_none_or(|worker| worker.bundle_id != bundle_fingerprint);
        if needs_worker {
            *guard = Some(SnpeffWorker::spawn(bundle, bundle_fingerprint)?);
        }
        let first = guard
            .as_mut()
            .expect("worker was initialized")
            .annotate(variant);
        match first {
            Ok(result) => Ok(result),
            Err(_) => {
                *guard = Some(SnpeffWorker::spawn(bundle, bundle_fingerprint)?);
                guard
                    .as_mut()
                    .expect("worker was restarted")
                    .annotate(variant)
            }
        }
    }
}

struct SnpeffWorker {
    bundle_id: String,
    child: Child,
    stdin: ChildStdin,
    records: Receiver<String>,
}

impl SnpeffWorker {
    fn spawn(bundle: &ResourceBundle, bundle_fingerprint: &str) -> Result<Self> {
        let mut command = Command::new(&bundle.java_path);
        command
            .args(["-Xmx4g", "-jar"])
            .arg(&bundle.snpeff_jar_path);
        if let Some(config) = &bundle.snpeff_config_path {
            command.arg("-c").arg(config);
        }
        command
            .args(["-noStats", "-noLog", "-noInteraction"])
            .arg(&bundle.snpeff_genome)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            DgwError::Tool(format!("cannot start persistent SnpEff worker: {error}"))
        })?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| DgwError::Tool("SnpEff stdin is unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| DgwError::Tool("SnpEff stdout is unavailable".into()))?;
        let stderr = child.stderr.take();
        let (sender, records) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(std::result::Result::ok) {
                if !line.starts_with('#') && !line.trim().is_empty() && sender.send(line).is_err() {
                    break;
                }
            }
        });
        if let Some(stderr) = stderr {
            thread::spawn(move || {
                for _ in BufReader::new(stderr)
                    .lines()
                    .map_while(std::result::Result::ok)
                {
                    // Drain stderr so a long-lived worker cannot block on a full pipe.
                }
            });
        }
        writeln!(stdin, "##fileformat=VCFv4.3")?;
        writeln!(
            stdin,
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDGW"
        )?;
        stdin.flush()?;
        Ok(Self {
            bundle_id: bundle_fingerprint.to_owned(),
            child,
            stdin,
            records,
        })
    }

    fn annotate(&mut self, variant: &VariantKey) -> Result<Vec<BTreeMap<String, String>>> {
        if self.child.try_wait()?.is_some() {
            return Err(DgwError::Tool("SnpEff worker exited".into()));
        }
        let token = format!("DGW_{}", Uuid::new_v4().simple());
        writeln!(
            self.stdin,
            "{}\t{}\t{}\t{}\t{}\t.\tPASS\t.\tGT\t0|1",
            variant.contig, variant.position, token, variant.reference, variant.alternate
        )?;
        self.stdin.flush()?;
        loop {
            let line = self
                .records
                .recv_timeout(Duration::from_secs(20))
                .map_err(|_| {
                    DgwError::Timeout("SnpEff did not return a record within 20 seconds".into())
                })?;
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 8 || fields[2] != token {
                continue;
            }
            let info = parse_info(fields[7]);
            let Some(annotation) = info.get("ANN") else {
                return Ok(Vec::new());
            };
            return Ok(annotation
                .split(',')
                .map(parse_ann_record)
                .collect::<Vec<_>>());
        }
    }
}

impl Drop for SnpeffWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn parse_ann_record(annotation: &str) -> BTreeMap<String, String> {
    const FIELDS: [&str; 16] = [
        "allele",
        "effect",
        "impact",
        "geneName",
        "geneId",
        "featureType",
        "featureId",
        "transcriptBiotype",
        "rank",
        "hgvsC",
        "hgvsP",
        "cdnaPosition",
        "cdsPosition",
        "proteinPosition",
        "distance",
        "warnings",
    ];
    let mut record = BTreeMap::new();
    for (index, value) in annotation.split('|').enumerate() {
        if !value.is_empty() {
            record.insert(
                FIELDS.get(index).copied().unwrap_or("extra").to_owned(),
                value.to_owned(),
            );
        }
    }
    record.insert("raw".into(), annotation.into());
    record
}

#[derive(Clone, Copy)]
enum ResourceKind {
    Vcf,
    Dbnsfp,
}

fn query_resource(
    tabix_path: &std::path::Path,
    resource: &IndexedResource,
    variant: &VariantKey,
    kind: ResourceKind,
) -> EvidenceResult {
    let source = resource.release.clone();
    if !resource.path.is_file() || !resource.index_path.is_file() {
        return EvidenceResult {
            source,
            status: EvidenceStatus::ResourceUnavailable,
            records: Vec::new(),
            message: Some("data or index file is missing".into()),
        };
    }
    let region = format!(
        "{}:{}-{}",
        variant.contig, variant.position, variant.position
    );
    let output = match Command::new(tabix_path)
        .arg(&resource.path)
        .arg(region)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return EvidenceResult {
                source,
                status: EvidenceStatus::ResourceUnavailable,
                records: Vec::new(),
                message: Some(error.to_string()),
            }
        }
    };
    if !output.status.success() {
        return EvidenceResult {
            source,
            status: EvidenceStatus::Error,
            records: Vec::new(),
            message: Some(String::from_utf8_lossy(&output.stderr).trim().into()),
        };
    }
    let mut records = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let matches = match kind {
            ResourceKind::Vcf => {
                fields.len() >= 8
                    && fields[0] == variant.contig
                    && fields[1].parse::<u64>().ok() == Some(variant.position)
                    && fields[3].eq_ignore_ascii_case(&variant.reference)
                    && fields[4]
                        .split(',')
                        .any(|alternate| alternate.eq_ignore_ascii_case(&variant.alternate))
            }
            ResourceKind::Dbnsfp => {
                fields.len() >= 4
                    && fields[0].trim_start_matches("chr")
                        == variant.contig.trim_start_matches("chr")
                    && fields[1].parse::<u64>().ok() == Some(variant.position)
                    && fields[2].eq_ignore_ascii_case(&variant.reference)
                    && fields[3].eq_ignore_ascii_case(&variant.alternate)
            }
        };
        if matches {
            let mut record = BTreeMap::new();
            record.insert("raw".into(), line.into());
            if matches!(kind, ResourceKind::Vcf) {
                record.insert("id".into(), fields[2].into());
                record.extend(parse_info(fields[7]));
            } else {
                if let Ok(columns) = dbnsfp_columns(&resource.path) {
                    for (column, value) in columns.iter().zip(fields.iter()) {
                        record.insert(column.clone(), (*value).into());
                    }
                } else {
                    record.insert("position".into(), fields[1].into());
                    record.insert("ref".into(), fields[2].into());
                    record.insert("alt".into(), fields[3].into());
                }
            }
            records.push(record);
        }
    }
    EvidenceResult {
        source,
        status: if records.is_empty() {
            EvidenceStatus::NoExactMatch
        } else {
            EvidenceStatus::Found
        },
        records,
        message: None,
    }
}

fn dbnsfp_columns(path: &std::path::Path) -> Result<Vec<String>> {
    let reader = BufReader::new(MultiGzDecoder::new(File::open(path)?));
    for line in reader.lines().take(20) {
        let line = line?;
        if line.starts_with("#chr\t") || line.starts_with("chr\t") {
            return Ok(line
                .trim_start_matches('#')
                .split('\t')
                .map(str::to_owned)
                .collect());
        }
    }
    Err(DgwError::InvalidResource(
        "dbNSFP column header was not found".into(),
    ))
}

pub fn normalize_variant(bundle: &ResourceBundle, variant: &VariantKey) -> Result<VariantKey> {
    let mut input = NamedTempFile::new()?;
    writeln!(input, "##fileformat=VCFv4.3")?;
    writeln!(input, "##contig=<ID={}>", variant.contig)?;
    writeln!(input, "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO")?;
    writeln!(
        input,
        "{}\t{}\t.\t{}\t{}\t.\tPASS\t.",
        variant.contig, variant.position, variant.reference, variant.alternate
    )?;
    input.flush()?;
    let output = Command::new(&bundle.bcftools_path)
        .arg("norm")
        .args(["-c", "e", "-f"])
        .arg(&bundle.reference_path)
        .args(["-Ov", "--no-version"])
        .arg(input.path())
        .output()?;
    if !output.status.success() {
        return Err(DgwError::InvalidEdit(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() >= 5 {
            return Ok(VariantKey {
                assembly: variant.assembly.clone(),
                contig: fields[0].into(),
                position: fields[1].parse().map_err(|_| {
                    DgwError::InvalidEdit("bcftools returned an invalid position".into())
                })?,
                reference: fields[3].into(),
                alternate: fields[4].into(),
            });
        }
    }
    Err(DgwError::InvalidEdit(
        "bcftools did not return a normalized variant".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_keys_are_resource_specific() {
        let variant = VariantKey {
            assembly: "b37".into(),
            contig: "7".into(),
            position: 140_453_136,
            reference: "A".into(),
            alternate: "T".into(),
        };
        assert_ne!(
            evaluation_cache_key(&variant, "bundle-a"),
            evaluation_cache_key(&variant, "bundle-b")
        );
    }

    #[test]
    fn parses_snpeff_ann_fields() {
        let parsed = parse_ann_record(
            "T|missense_variant|MODERATE|BRAF|673|transcript|ENST1|protein_coding|15/18|c.1799T>A|p.Val600Glu",
        );
        assert_eq!(parsed.get("geneName").map(String::as_str), Some("BRAF"));
        assert_eq!(parsed.get("hgvsP").map(String::as_str), Some("p.Val600Glu"));
    }
}
