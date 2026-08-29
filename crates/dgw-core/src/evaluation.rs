use crate::device::built_in_device_manifest;
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
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
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

pub fn device_evaluation_cache_key(
    variant: &VariantKey,
    device_id: &str,
    device_version: &str,
    resource_fingerprint: &str,
) -> String {
    let value = format!(
        "dgw-device-eval-v1|{}|{}|{}|{}",
        variant.stable_key(),
        device_id,
        device_version,
        resource_fingerprint
    );
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// Builds the identity of the resource that is scientifically relevant to one
/// built-in evidence device. Database devices are deliberately independent of
/// one another, so replacing COSMIC does not invalidate ClinVar or dbNSFP.
pub fn device_resource_fingerprint(
    bundle: &ResourceBundle,
    bundle_fingerprint: &str,
    device_id: &str,
) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(b"dgw-device-resource-v1\0");
    hasher.update(bundle.schema_version.to_le_bytes());
    hash_field(&mut hasher, &bundle.assembly);
    hash_field(&mut hasher, device_id);
    match device_id {
        "org.dgw.builtin.snpeff" => {
            // ResourceBundle v1 has no separate fingerprint for the SnpEff
            // database directory. Keep the pinned bundle identity as a safe
            // fallback, then add the concrete runtime inputs and metadata.
            hash_field(&mut hasher, bundle_fingerprint);
            hash_field(&mut hasher, &bundle.snpeff_version);
            hash_field(&mut hasher, &bundle.snpeff_genome);
            hash_path_identity(&mut hasher, "java", &bundle.java_path);
            hash_path_identity(&mut hasher, "snpeff-jar", &bundle.snpeff_jar_path);
            if let Some(config) = &bundle.snpeff_config_path {
                hash_path_identity(&mut hasher, "snpeff-config", config);
            } else {
                hasher.update(b"snpeff-config\0none\0");
            }
            if let Some(predictor) = configured_snpeff_predictor(bundle) {
                hash_path_identity(&mut hasher, "snpeff-predictor", &predictor);
            }
        }
        "org.dgw.builtin.dbnsfp" => {
            hash_indexed_resource(&mut hasher, &bundle.tabix_path, &bundle.dbnsfp)?;
        }
        "org.dgw.builtin.clinvar" => {
            hash_indexed_resource(&mut hasher, &bundle.tabix_path, &bundle.clinvar)?;
        }
        "org.dgw.builtin.cosmic" => {
            hash_indexed_resource(&mut hasher, &bundle.tabix_path, &bundle.cosmic)?;
        }
        _ => {
            return Err(DgwError::InvalidDevice(format!(
                "device {device_id} cannot evaluate a selected allele"
            )))
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

fn hash_indexed_resource(
    hasher: &mut Sha256,
    tabix_path: &Path,
    resource: &IndexedResource,
) -> Result<()> {
    hash_field(hasher, &serde_json::to_string(resource)?);
    hash_path_identity(hasher, "tabix", tabix_path);
    hash_path_identity(hasher, "data", &resource.path);
    hash_path_identity(hasher, "index", &resource.index_path);
    Ok(())
}

fn hash_field(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

fn hash_path_identity(hasher: &mut Sha256, label: &str, path: &Path) {
    hash_field(hasher, label);
    hash_field(hasher, &path.to_string_lossy());
    match fs::metadata(path) {
        Ok(metadata) => {
            hasher.update(b"present\0");
            hasher.update(metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified() {
                if let Ok(elapsed) = modified.duration_since(UNIX_EPOCH) {
                    hasher.update(elapsed.as_secs().to_le_bytes());
                    hasher.update(elapsed.subsec_nanos().to_le_bytes());
                }
            }
        }
        Err(_) => hasher.update(b"missing\0"),
    }
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
        // Always assemble through the device boundary. Each call is cheap when
        // its exact allele/resource entry is already cached, and one missing or
        // replaced optional database does not invalidate the other devices.
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
        .all(|evidence| is_durable_evidence(evidence));
        if durable {
            // Keep the v1 combined entry for existing export/provenance callers.
            // Device-specific entries remain the authoritative reusable cache.
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
        let manifest = built_in_device_manifest(device_id).ok_or_else(|| {
            DgwError::InvalidDevice(format!(
                "device {device_id} cannot evaluate a selected allele"
            ))
        })?;
        if !matches!(
            device_id,
            "org.dgw.builtin.snpeff"
                | "org.dgw.builtin.dbnsfp"
                | "org.dgw.builtin.clinvar"
                | "org.dgw.builtin.cosmic"
        ) {
            return Err(DgwError::InvalidDevice(format!(
                "device {device_id} cannot evaluate a selected allele"
            )));
        }
        let resource_fingerprint = device_resource_fingerprint(
            bundle,
            &project.manifest().resource_bundle_fingerprint,
            device_id,
        )?;
        let cache_key = device_evaluation_cache_key(
            variant,
            device_id,
            &manifest.version,
            &resource_fingerprint,
        );
        if let Some(cached) = project.cache_get(&cache_key)? {
            if cached.variant == *variant {
                if let Some(evidence) = evidence_for_device(&cached, device_id) {
                    if is_durable_evidence(evidence) {
                        return Ok(evidence.clone());
                    }
                }
            }
        }

        let result = match device_id {
            "org.dgw.builtin.snpeff" => match snpeff_resource_unavailable(bundle) {
                Some(message) => EvidenceResult {
                    source: "SnpEff".into(),
                    status: EvidenceStatus::ResourceUnavailable,
                    records: Vec::new(),
                    message: Some(message),
                },
                None => match self.annotate_snpeff(bundle, &resource_fingerprint, variant) {
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
            _ => unreachable!("supported evidence device was checked above"),
        };
        if is_durable_evidence(&result) {
            project.cache_put(&device_cache_envelope(
                &project.manifest().resource_bundle_fingerprint,
                variant,
                cache_key,
                device_id,
                result.clone(),
            ))?;
        }
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

fn is_durable_evidence(evidence: &EvidenceResult) -> bool {
    matches!(
        evidence.status,
        EvidenceStatus::Found | EvidenceStatus::NoExactMatch
    )
}

fn evidence_for_device<'a>(
    evaluation: &'a EvaluationResult,
    device_id: &str,
) -> Option<&'a EvidenceResult> {
    match device_id {
        "org.dgw.builtin.snpeff" => Some(&evaluation.snpeff),
        "org.dgw.builtin.dbnsfp" => Some(&evaluation.dbnsfp),
        "org.dgw.builtin.clinvar" => Some(&evaluation.clinvar),
        "org.dgw.builtin.cosmic" => Some(&evaluation.cosmic),
        _ => None,
    }
}

fn device_cache_envelope(
    bundle_fingerprint: &str,
    variant: &VariantKey,
    cache_key: String,
    device_id: &str,
    evidence: EvidenceResult,
) -> EvaluationResult {
    let mut result = EvaluationResult {
        variant: variant.clone(),
        cache_key,
        snpeff: not_computed_evidence("SnpEff"),
        dbnsfp: not_computed_evidence("dbNSFP"),
        clinvar: not_computed_evidence("ClinVar"),
        cosmic: not_computed_evidence("COSMIC"),
        evaluated_at: Utc::now(),
        resource_bundle_fingerprint: bundle_fingerprint.into(),
        limitation: "Per-device evidence cache entry; evidence applies only to the exact normalized allele and pinned device resource.".into(),
    };
    match device_id {
        "org.dgw.builtin.snpeff" => result.snpeff = evidence,
        "org.dgw.builtin.dbnsfp" => result.dbnsfp = evidence,
        "org.dgw.builtin.clinvar" => result.clinvar = evidence,
        "org.dgw.builtin.cosmic" => result.cosmic = evidence,
        _ => unreachable!("cache envelopes are built only for supported evidence devices"),
    }
    result
}

fn not_computed_evidence(source: &str) -> EvidenceResult {
    EvidenceResult {
        source: source.into(),
        status: EvidenceStatus::NotComputed,
        records: Vec::new(),
        message: None,
    }
}

fn snpeff_resource_unavailable(bundle: &ResourceBundle) -> Option<String> {
    let required = [
        (&bundle.java_path, "Java executable"),
        (&bundle.snpeff_jar_path, "SnpEff JAR"),
    ];
    for (path, label) in required {
        if !path.is_file() {
            return Some(format!("{label} is missing: {}", path.display()));
        }
    }
    if let Some(config) = &bundle.snpeff_config_path {
        if !config.is_file() {
            return Some(format!(
                "SnpEff configuration is missing: {}",
                config.display()
            ));
        }
    }
    if bundle.snpeff_genome.trim().is_empty() {
        return Some("SnpEff genome identifier is not configured".into());
    }
    if let Some(predictor) = configured_snpeff_predictor(bundle) {
        if !predictor.is_file() {
            return Some(format!(
                "SnpEff database {} is missing: {}",
                bundle.snpeff_genome,
                predictor.display()
            ));
        }
    }
    None
}

fn configured_snpeff_predictor(bundle: &ResourceBundle) -> Option<PathBuf> {
    let config = bundle.snpeff_config_path.as_ref()?;
    let contents = fs::read_to_string(config).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('#') || !line.starts_with("data.dir") {
            continue;
        }
        let Some(remainder) = line.strip_prefix("data.dir") else {
            continue;
        };
        let remainder = remainder.trim_start();
        let Some(value) = remainder
            .strip_prefix('=')
            .or_else(|| remainder.strip_prefix(':'))
        else {
            continue;
        };
        let value = value.split('#').next().unwrap_or_default().trim();
        if value.is_empty() {
            continue;
        }
        let data_dir = PathBuf::from(value);
        // Relative SnpEff data.dir semantics depend on the process working
        // directory, which ResourceBundle v1 does not pin. Avoid guessing.
        if data_dir.is_absolute() {
            return Some(
                data_dir
                    .join(&bundle.snpeff_genome)
                    .join("snpEffectPredictor.bin"),
            );
        }
    }
    None
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
    if !tabix_path.is_file() {
        return EvidenceResult {
            source,
            status: EvidenceStatus::ResourceUnavailable,
            records: Vec::new(),
            message: Some(format!(
                "tabix executable is missing: {}",
                tabix_path.display()
            )),
        };
    }
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
            } else if let Ok(columns) = dbnsfp_columns(&resource.path) {
                for (column, value) in columns.iter().zip(fields.iter()) {
                    record.insert(column.clone(), (*value).into());
                }
            } else {
                record.insert("position".into(), fields[1].into());
                record.insert("ref".into(), fields[2].into());
                record.insert("alt".into(), fields[3].into());
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

    fn indexed_resource(name: &str) -> IndexedResource {
        IndexedResource {
            path: format!("/configured/{name}.gz").into(),
            index_path: format!("/configured/{name}.gz.tbi").into(),
            release: format!("{name}-release"),
            license_label: "test".into(),
            fingerprint: None,
        }
    }

    fn resource_bundle() -> ResourceBundle {
        ResourceBundle {
            schema_version: 1,
            id: "test-bundle".into(),
            assembly: "b37".into(),
            contig_style: "no_chr_prefix".into(),
            reference_path: "/configured/reference.fa.gz".into(),
            reference_fai_path: "/configured/reference.fa.gz.fai".into(),
            reference_gzi_path: None,
            java_path: "/configured/java".into(),
            snpeff_jar_path: "/configured/snpEff.jar".into(),
            snpeff_config_path: Some("/configured/snpEff.config".into()),
            snpeff_genome: "hg19".into(),
            snpeff_version: "5.0e".into(),
            bcftools_path: "/configured/bcftools".into(),
            bgzip_path: "/configured/bgzip".into(),
            tabix_path: "/configured/tabix".into(),
            dbnsfp: indexed_resource("dbnsfp"),
            clinvar: indexed_resource("clinvar"),
            cosmic: indexed_resource("cosmic"),
            bundle_fingerprint: None,
        }
    }

    fn variant() -> VariantKey {
        VariantKey {
            assembly: "b37".into(),
            contig: "7".into(),
            position: 140_453_136,
            reference: "A".into(),
            alternate: "T".into(),
        }
    }

    #[test]
    fn cache_keys_are_resource_specific() {
        let variant = variant();
        assert_ne!(
            evaluation_cache_key(&variant, "bundle-a"),
            evaluation_cache_key(&variant, "bundle-b")
        );
    }

    #[test]
    fn device_cache_keys_bind_allele_device_version_and_resource() {
        let variant = variant();
        let base =
            device_evaluation_cache_key(&variant, "org.dgw.builtin.clinvar", "0.1.0", "clinvar-a");
        let mut other_allele = variant.clone();
        other_allele.alternate = "G".into();
        assert_ne!(
            base,
            device_evaluation_cache_key(
                &other_allele,
                "org.dgw.builtin.clinvar",
                "0.1.0",
                "clinvar-a"
            )
        );
        assert_ne!(
            base,
            device_evaluation_cache_key(&variant, "org.dgw.builtin.cosmic", "0.1.0", "clinvar-a")
        );
        assert_ne!(
            base,
            device_evaluation_cache_key(&variant, "org.dgw.builtin.clinvar", "0.2.0", "clinvar-a")
        );
        assert_ne!(
            base,
            device_evaluation_cache_key(&variant, "org.dgw.builtin.clinvar", "0.1.0", "clinvar-b")
        );
    }

    #[test]
    fn database_fingerprints_ignore_unrelated_optional_resources() {
        let bundle = resource_bundle();
        let clinvar =
            device_resource_fingerprint(&bundle, "bundle-a", "org.dgw.builtin.clinvar").unwrap();

        let mut cosmic_changed = bundle.clone();
        cosmic_changed.cosmic.release = "different-cosmic-release".into();
        assert_eq!(
            clinvar,
            device_resource_fingerprint(&cosmic_changed, "bundle-b", "org.dgw.builtin.clinvar")
                .unwrap()
        );

        let mut clinvar_changed = bundle;
        clinvar_changed.clinvar.release = "different-clinvar-release".into();
        assert_ne!(
            clinvar,
            device_resource_fingerprint(&clinvar_changed, "bundle-a", "org.dgw.builtin.clinvar")
                .unwrap()
        );
    }

    #[test]
    fn only_terminal_exact_lookup_results_are_durable() {
        for (status, durable) in [
            (EvidenceStatus::Found, true),
            (EvidenceStatus::NoExactMatch, true),
            (EvidenceStatus::NotComputed, false),
            (EvidenceStatus::ResourceUnavailable, false),
            (EvidenceStatus::Error, false),
        ] {
            assert_eq!(
                is_durable_evidence(&EvidenceResult {
                    source: "test".into(),
                    status,
                    records: Vec::new(),
                    message: None,
                }),
                durable
            );
        }
    }

    #[test]
    fn per_device_cache_envelope_keeps_other_devices_not_computed() {
        let evidence = EvidenceResult {
            source: "ClinVar release".into(),
            status: EvidenceStatus::Found,
            records: vec![BTreeMap::from([("CLNSIG".into(), "Benign".into())])],
            message: None,
        };
        let envelope = device_cache_envelope(
            "bundle-a",
            &variant(),
            "cache-key".into(),
            "org.dgw.builtin.clinvar",
            evidence.clone(),
        );
        assert_eq!(envelope.clinvar, evidence);
        assert_eq!(envelope.snpeff.status, EvidenceStatus::NotComputed);
        assert_eq!(envelope.dbnsfp.status, EvidenceStatus::NotComputed);
        assert_eq!(envelope.cosmic.status, EvidenceStatus::NotComputed);
        assert_eq!(
            evidence_for_device(&envelope, "org.dgw.builtin.clinvar"),
            Some(&envelope.clinvar)
        );
    }

    #[test]
    fn configured_snpeff_database_is_part_of_availability() {
        let temporary = tempfile::tempdir().unwrap();
        let data_dir = temporary.path().join("data");
        let config = temporary.path().join("snpEff.config");
        std::fs::write(&config, format!("data.dir = {}\n", data_dir.display())).unwrap();

        let mut bundle = resource_bundle();
        bundle.snpeff_config_path = Some(config);
        let expected = data_dir.join("hg19").join("snpEffectPredictor.bin");
        assert_eq!(configured_snpeff_predictor(&bundle), Some(expected.clone()));

        // The Java and JAR checks run first; create them so the missing pinned
        // database is the reported optional-resource condition.
        bundle.java_path = temporary.path().join("java");
        bundle.snpeff_jar_path = temporary.path().join("snpEff.jar");
        std::fs::write(&bundle.java_path, b"test").unwrap();
        std::fs::write(&bundle.snpeff_jar_path, b"test").unwrap();
        assert!(snpeff_resource_unavailable(&bundle)
            .is_some_and(|message| message.contains(&expected.display().to_string())));
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
