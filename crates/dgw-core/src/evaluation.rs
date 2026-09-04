use crate::device::{built_in_device_manifest, canonical_device_id, CONSEQUENCE_DEVICE_ID};
use crate::error::{DgwError, Result};
use crate::model::{
    EvaluationResult, EvidenceResult, EvidenceStatus, IndexedResource, ResourceBundle, VariantKey,
};
use crate::optimizer::{OptimizerRequest, SaturationAlleleInput};
use crate::project::Project;
use crate::vcf::{parse_info, translate_contig_style};
use chrono::Utc;
use flate2::read::MultiGzDecoder;
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::UNIX_EPOCH;
use tempfile::NamedTempFile;

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
    let device_id = canonical_device_id(device_id);
    let mut hasher = Sha256::new();
    hasher.update(b"dgw-device-resource-v1\0");
    hasher.update(bundle.schema_version.to_le_bytes());
    hash_field(&mut hasher, &bundle.assembly);
    hash_field(&mut hasher, device_id);
    match device_id {
        CONSEQUENCE_DEVICE_ID => {
            hash_field(&mut hasher, bundle_fingerprint);
            hash_field(&mut hasher, &bundle.bcftools_version);
            hash_path_identity(&mut hasher, "bcftools", &bundle.bcftools_path);
            hash_path_identity(&mut hasher, "reference", &bundle.reference_path);
            if let Some(annotation) = &bundle.consequence_annotation {
                hash_field(&mut hasher, &serde_json::to_string(annotation)?);
                hash_path_identity(&mut hasher, "consequence-gff3", &annotation.path);
            } else {
                hasher.update(b"consequence-annotation\0none\0");
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
    consequence_lock: Mutex<()>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BatchEvidenceSignal {
    pub status: EvidenceStatus,
    pub exact_match_count: u32,
    pub impact_signal: Option<f64>,
    pub impact_label: Option<String>,
    pub clinvar_classification: Option<String>,
    pub no_transcript_feature: bool,
}

impl Default for EvaluationService {
    fn default() -> Self {
        Self::new()
    }
}

impl EvaluationService {
    pub fn new() -> Self {
        Self {
            consequence_lock: Mutex::new(()),
        }
    }

    pub fn evaluate(&self, project: &Project, variant: &VariantKey) -> Result<EvaluationResult> {
        let cache_key =
            evaluation_cache_key(variant, &project.manifest().resource_bundle_fingerprint);
        // Always assemble through the device boundary. Each call is cheap when
        // its exact allele/resource entry is already cached, and one missing or
        // replaced optional database does not invalidate the other devices.
        let consequence = self.evaluate_device(project, variant, CONSEQUENCE_DEVICE_ID)?;
        let dbnsfp = self.evaluate_device(project, variant, "org.dgw.builtin.dbnsfp")?;
        let clinvar = self.evaluate_device(project, variant, "org.dgw.builtin.clinvar")?;
        let cosmic = self.evaluate_device(project, variant, "org.dgw.builtin.cosmic")?;
        let result = EvaluationResult {
            variant: variant.clone(),
            cache_key,
            consequence,
            dbnsfp,
            clinvar,
            cosmic,
            evaluated_at: Utc::now(),
            resource_bundle_fingerprint: project.manifest().resource_bundle_fingerprint.clone(),
            limitation: "Consequences are evaluated independently per variant; compound haplotype-aware transcript consequences are not computed in DGW v1.".into(),
        };
        let durable = [
            &result.consequence,
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
        let device_id = canonical_device_id(device_id);
        let bundle = &project.manifest().resource_bundle;
        let manifest = built_in_device_manifest(device_id).ok_or_else(|| {
            DgwError::InvalidDevice(format!(
                "device {device_id} cannot evaluate a selected allele"
            ))
        })?;
        if !matches!(
            device_id,
            CONSEQUENCE_DEVICE_ID
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
            CONSEQUENCE_DEVICE_ID => match consequence_resource_unavailable(bundle) {
                Some(message) => EvidenceResult {
                    source: "Variant Consequences".into(),
                    status: EvidenceStatus::ResourceUnavailable,
                    records: Vec::new(),
                    message: Some(message),
                },
                None => match self.annotate_consequences(bundle, std::slice::from_ref(variant)) {
                    Ok(mut results) => results.remove(0),
                    Err(error) => EvidenceResult {
                        source: "Variant Consequences".into(),
                        status: EvidenceStatus::Error,
                        records: Vec::new(),
                        message: Some(error.to_string()),
                    },
                },
            },
            "org.dgw.builtin.dbnsfp" => query_resource(
                &bundle.tabix_path,
                &bundle.dbnsfp,
                &bundle.contig_style,
                variant,
                ResourceKind::Dbnsfp,
            ),
            "org.dgw.builtin.clinvar" => query_resource(
                &bundle.tabix_path,
                &bundle.clinvar,
                &bundle.contig_style,
                variant,
                ResourceKind::Vcf,
            ),
            "org.dgw.builtin.cosmic" => query_resource(
                &bundle.tabix_path,
                &bundle.cosmic,
                &bundle.contig_style,
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

    /// Evaluate many exact alleles while retaining only the compact signal
    /// required by Track Profiler. The consequence engine receives the complete
    /// request as one VCF batch so bcftools parses the transcript model once.
    /// Indexed databases use bounded region-file queries. Detailed single-allele
    /// inspection remains available separately.
    pub fn evaluate_device_signals<F>(
        &self,
        project: &Project,
        variants: &[VariantKey],
        device_id: &str,
        on_progress: F,
    ) -> Result<BTreeMap<VariantKey, BatchEvidenceSignal>>
    where
        F: FnMut(usize, usize) -> Result<()> + Send,
    {
        self.evaluate_device_signals_with_threads(project, variants, device_id, 1, on_progress)
    }

    /// Evaluate indexed-resource batches on the caller's current Rayon pool.
    /// Consequence prediction remains one complete batch so its transcript
    /// model is loaded once. A thread limit of one preserves the serial path.
    pub fn evaluate_device_signals_with_threads<F>(
        &self,
        project: &Project,
        variants: &[VariantKey],
        device_id: &str,
        worker_threads: usize,
        mut on_progress: F,
    ) -> Result<BTreeMap<VariantKey, BatchEvidenceSignal>>
    where
        F: FnMut(usize, usize) -> Result<()> + Send,
    {
        let total = variants.len();
        let device_id = canonical_device_id(device_id);
        if device_id == CONSEQUENCE_DEVICE_ID {
            let mut signals = BTreeMap::new();
            let bundle = &project.manifest().resource_bundle;
            let evidence_batch = if let Some(message) = consequence_resource_unavailable(bundle) {
                vec![
                    EvidenceResult {
                        source: "Variant Consequences".into(),
                        status: EvidenceStatus::ResourceUnavailable,
                        records: Vec::new(),
                        message: Some(message),
                    };
                    variants.len()
                ]
            } else {
                match self.annotate_consequences(bundle, variants) {
                    Ok(results) => results,
                    Err(error) => vec![
                        EvidenceResult {
                            source: "Variant Consequences".into(),
                            status: EvidenceStatus::Error,
                            records: Vec::new(),
                            message: Some(error.to_string()),
                        };
                        variants.len()
                    ],
                }
            };
            for (variant, evidence) in variants.iter().zip(evidence_batch) {
                signals.insert(
                    variant.clone(),
                    BatchEvidenceSignal {
                        impact_signal: consequence_impact_signal(&evidence),
                        impact_label: consequence_impact_label(&evidence),
                        clinvar_classification: None,
                        exact_match_count: evidence.records.len() as u32,
                        no_transcript_feature: evidence.records.iter().any(|record| {
                            record
                                .get("effect")
                                .is_some_and(|effect| effect == "no_transcript_feature")
                        }),
                        status: evidence.status,
                    },
                );
            }
            on_progress(total, total)?;
            return Ok(signals);
        }

        let bundle = &project.manifest().resource_bundle;
        let (resource, kind) = match device_id {
            "org.dgw.builtin.dbnsfp" => (&bundle.dbnsfp, ResourceKind::Dbnsfp),
            "org.dgw.builtin.clinvar" => (&bundle.clinvar, ResourceKind::Vcf),
            "org.dgw.builtin.cosmic" => (&bundle.cosmic, ResourceKind::Vcf),
            _ => {
                return Err(DgwError::InvalidDevice(format!(
                    "device {device_id} cannot evaluate a track"
                )))
            }
        };
        const INDEXED_RESOURCE_BATCH_SIZE: usize = 2_000;
        if worker_threads > 1 && variants.len() > INDEXED_RESOURCE_BATCH_SIZE {
            let completed = AtomicUsize::new(0);
            let progress = Mutex::new(&mut on_progress);
            let chunks = variants
                .par_chunks(INDEXED_RESOURCE_BATCH_SIZE)
                .map(|chunk| {
                    let result = query_resource_signals_batch(
                        &bundle.tabix_path,
                        resource,
                        &bundle.contig_style,
                        chunk,
                        kind,
                    )?;
                    let processed =
                        completed.fetch_add(chunk.len(), Ordering::Relaxed) + chunk.len();
                    progress.lock().map_err(|_| {
                        DgwError::Tool("Evidence progress lock is poisoned".into())
                    })?(processed.min(total), total)?;
                    Ok(result)
                })
                .collect::<Result<Vec<_>>>()?;
            return Ok(chunks.into_iter().flatten().collect());
        }
        let mut signals = BTreeMap::new();
        for (chunk_index, chunk) in variants.chunks(INDEXED_RESOURCE_BATCH_SIZE).enumerate() {
            signals.extend(query_resource_signals_batch(
                &bundle.tabix_path,
                resource,
                &bundle.contig_style,
                chunk,
                kind,
            )?);
            on_progress(
                ((chunk_index + 1) * INDEXED_RESOURCE_BATCH_SIZE).min(total),
                total,
            )?;
        }
        Ok(signals)
    }

    /// Prepare the exact live evidence required by Saturation. Keeping this
    /// adapter beside the evaluation engine ensures desktop and acceptance
    /// workflows use the same three-ALT candidate contract.
    pub fn evaluate_saturation_candidates(
        &self,
        project: &Project,
        request: &OptimizerRequest,
    ) -> Result<Vec<SaturationAlleleInput>> {
        const CLINVAR: &str = "org.dgw.builtin.clinvar";
        if !request
            .evidence_device_ids
            .iter()
            .any(|device_id| device_id == CONSEQUENCE_DEVICE_ID)
        {
            return Err(DgwError::InvalidDevice(
                "Saturation mode requires applied, active Variant Consequences for comparable candidate scoring.".into(),
            ));
        }
        if !request
            .evidence_device_ids
            .iter()
            .any(|device_id| device_id == CLINVAR)
        {
            return Err(DgwError::InvalidDevice(
                "Saturation mode requires an applied, active ClinVar device for the fixed Pathogenic/Likely pathogenic guard.".into(),
            ));
        }

        let mut candidates = Vec::new();
        for selected in &request.selected_variants {
            if selected.reference.len() != 1
                || selected.alternate.len() != 1
                || !matches!(
                    selected.reference.as_bytes()[0].to_ascii_uppercase(),
                    b'A' | b'C' | b'G' | b'T'
                )
            {
                continue;
            }
            let reference = selected.reference.as_bytes()[0].to_ascii_uppercase();
            for alternate in [b'A', b'C', b'G', b'T']
                .into_iter()
                .filter(|alternate| *alternate != reference)
            {
                candidates.push((
                    selected.clone(),
                    VariantKey {
                        assembly: selected.assembly.clone(),
                        contig: selected.contig.clone(),
                        position: selected.position,
                        reference: char::from(reference).to_string(),
                        alternate: char::from(alternate).to_string(),
                    },
                ));
            }
        }

        let candidate_keys: Vec<_> = candidates
            .iter()
            .map(|(_, candidate)| candidate.clone())
            .collect();
        let consequence = self.evaluate_device_signals(
            project,
            &candidate_keys,
            CONSEQUENCE_DEVICE_ID,
            |_, _| Ok(()),
        )?;
        let clinvar =
            self.evaluate_device_signals(project, &candidate_keys, CLINVAR, |_, _| Ok(()))?;
        let mut evaluated = Vec::with_capacity(candidates.len());
        for (source, candidate) in candidates {
            let consequence_signal = consequence.get(&candidate).ok_or_else(|| {
                DgwError::Tool(format!(
                    "Variant Consequences omitted candidate {}",
                    candidate.display()
                ))
            })?;
            if matches!(
                consequence_signal.status,
                EvidenceStatus::Error | EvidenceStatus::ResourceUnavailable
            ) {
                return Err(DgwError::Tool(format!(
                    "Variant Consequences could not evaluate saturation candidate {}",
                    candidate.display()
                )));
            }
            let clinvar_signal = clinvar.get(&candidate).ok_or_else(|| {
                DgwError::Tool(format!("ClinVar omitted candidate {}", candidate.display()))
            })?;
            let consequence_evidence =
                evidence_from_batch_signal("Variant Consequences", consequence_signal);
            let clinvar_evidence = evidence_from_batch_signal(
                &project.manifest().resource_bundle.clinvar.release,
                clinvar_signal,
            );
            evaluated.push(SaturationAlleleInput {
                source_variant: source,
                candidate_variant: candidate,
                consequence: consequence_evidence,
                clinvar: clinvar_evidence.clone(),
                evidence_statuses: BTreeMap::from([
                    (
                        CONSEQUENCE_DEVICE_ID.into(),
                        evidence_status_label(&consequence_signal.status).into(),
                    ),
                    (
                        CLINVAR.into(),
                        evidence_status_label(&clinvar_signal.status).into(),
                    ),
                ]),
                exact_evidence_sources: (clinvar_signal.status == EvidenceStatus::Found)
                    .then(|| clinvar_evidence.source.clone())
                    .into_iter()
                    .collect(),
            });
        }
        Ok(evaluated)
    }

    fn annotate_consequences(
        &self,
        bundle: &ResourceBundle,
        variants: &[VariantKey],
    ) -> Result<Vec<EvidenceResult>> {
        let _guard = self
            .consequence_lock
            .lock()
            .map_err(|_| DgwError::Tool("consequence-engine lock is poisoned".into()))?;
        annotate_consequence_batch(bundle, variants)
    }
}

fn evidence_from_batch_signal(source: &str, signal: &BatchEvidenceSignal) -> EvidenceResult {
    let mut record = BTreeMap::new();
    if let Some(impact) = &signal.impact_label {
        record.insert("impact".into(), impact.clone());
    }
    if let Some(classification) = &signal.clinvar_classification {
        record.insert("CLNSIG".into(), classification.clone());
    }
    EvidenceResult {
        source: source.into(),
        status: signal.status.clone(),
        records: (!record.is_empty()).then_some(record).into_iter().collect(),
        message: None,
    }
}

fn evidence_status_label(status: &EvidenceStatus) -> &'static str {
    match status {
        EvidenceStatus::Found => "found",
        EvidenceStatus::NoExactMatch => "noExactMatch",
        EvidenceStatus::NotComputed => "notComputed",
        EvidenceStatus::ResourceUnavailable => "resourceUnavailable",
        EvidenceStatus::Error => "error",
    }
}

fn consequence_impact_signal(evidence: &EvidenceResult) -> Option<f64> {
    if evidence.status != EvidenceStatus::Found {
        return None;
    }
    evidence
        .records
        .iter()
        .map(
            |record| match record.get("impact").map(|value| value.to_ascii_uppercase()) {
                Some(value) if value == "HIGH" => 1.0,
                Some(value) if value == "MODERATE" => 0.67,
                Some(value) if value == "LOW" => 0.33,
                Some(value) if value == "MODIFIER" => 0.1,
                _ => 0.0,
            },
        )
        .reduce(f64::max)
}

fn consequence_impact_label(evidence: &EvidenceResult) -> Option<String> {
    evidence
        .records
        .iter()
        .filter_map(|record| record.get("impact").or_else(|| record.get("IMPACT")))
        .flat_map(|value| value.split([',', '|', '/', '&']))
        .filter_map(|label| {
            let normalized = label.trim().to_ascii_uppercase();
            let score = match normalized.as_str() {
                "HIGH" => 4,
                "MODERATE" => 3,
                "LOW" => 2,
                "MODIFIER" => 1,
                _ => return None,
            };
            Some((score, normalized))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, label)| label)
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
    match canonical_device_id(device_id) {
        CONSEQUENCE_DEVICE_ID => Some(&evaluation.consequence),
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
        consequence: not_computed_evidence("Variant Consequences"),
        dbnsfp: not_computed_evidence("dbNSFP"),
        clinvar: not_computed_evidence("ClinVar"),
        cosmic: not_computed_evidence("COSMIC"),
        evaluated_at: Utc::now(),
        resource_bundle_fingerprint: bundle_fingerprint.into(),
        limitation: "Per-device evidence cache entry; evidence applies only to the exact normalized allele and pinned device resource.".into(),
    };
    match canonical_device_id(device_id) {
        CONSEQUENCE_DEVICE_ID => result.consequence = evidence,
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

fn consequence_resource_unavailable(bundle: &ResourceBundle) -> Option<String> {
    if !bundle.bcftools_path.is_file() {
        return Some(format!(
            "bcftools executable is missing: {}",
            bundle.bcftools_path.display()
        ));
    }
    if !bundle.reference_path.is_file() {
        return Some(format!(
            "reference FASTA is missing: {}",
            bundle.reference_path.display()
        ));
    }
    let Some(annotation) = &bundle.consequence_annotation else {
        return Some("consequence annotation GFF3 is not configured".into());
    };
    if !annotation.path.is_file() {
        return Some(format!(
            "consequence annotation GFF3 is missing: {}",
            annotation.path.display()
        ));
    }
    None
}

fn annotate_consequence_batch(
    bundle: &ResourceBundle,
    variants: &[VariantKey],
) -> Result<Vec<EvidenceResult>> {
    if variants.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(message) = consequence_resource_unavailable(bundle) {
        return Err(DgwError::InvalidResource(message));
    }
    let annotation = bundle
        .consequence_annotation
        .as_ref()
        .expect("availability check requires consequence annotation");
    let mut input = NamedTempFile::new()?;
    writeln!(input, "##fileformat=VCFv4.3")?;
    let contigs: BTreeSet<&str> = variants
        .iter()
        .map(|variant| variant.contig.as_str())
        .collect();
    for contig in contigs {
        writeln!(input, "##contig=<ID={contig}>")?;
    }
    writeln!(input, "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO")?;
    let mut ordered_indices: Vec<usize> = (0..variants.len()).collect();
    ordered_indices.sort_by(|left, right| {
        let left = &variants[*left];
        let right = &variants[*right];
        (
            &left.contig,
            left.position,
            &left.reference,
            &left.alternate,
        )
            .cmp(&(
                &right.contig,
                right.position,
                &right.reference,
                &right.alternate,
            ))
    });
    for index in ordered_indices {
        let variant = &variants[index];
        writeln!(
            input,
            "{}\t{}\tDGW_CSQ_{}\t{}\t{}\t.\tPASS\t.",
            variant.contig, variant.position, index, variant.reference, variant.alternate
        )?;
    }
    input.flush()?;

    let output = NamedTempFile::new()?;
    let mut command = Command::new(&bundle.bcftools_path);
    command
        .arg("csq")
        .args(["--local-csq", "--ncsq", "64", "--fasta-ref"])
        .arg(&bundle.reference_path)
        .arg("--gff-annot")
        .arg(&annotation.path);
    if bundle.contig_style != annotation.contig_style {
        let prefix = |style: &str| if style == "chr_prefix" { "chr" } else { "-" };
        command.arg("--unify-chr-names").arg(format!(
            "{},{},{}",
            prefix(&bundle.contig_style),
            prefix(&annotation.contig_style),
            prefix(&bundle.contig_style)
        ));
    }
    let process = command
        .args(["--output-type", "v", "--output"])
        .arg(output.path())
        .arg(input.path())
        .output()?;
    if !process.status.success() {
        return Err(DgwError::Tool(format!(
            "bcftools csq failed: {}",
            String::from_utf8_lossy(&process.stderr).trim()
        )));
    }

    let source = format!("Variant Consequences · {}", annotation.release);
    let mut results = vec![None; variants.len()];
    for line in BufReader::new(File::open(output.path())?).lines() {
        let line = line?;
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 8 {
            return Err(DgwError::Tool(
                "bcftools csq returned a malformed VCF record".into(),
            ));
        }
        let index = fields[2]
            .strip_prefix("DGW_CSQ_")
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|index| *index < variants.len())
            .ok_or_else(|| DgwError::Tool("bcftools csq returned an unknown record ID".into()))?;
        let info = parse_info(fields[7]);
        let records = info
            .get("BCSQ")
            .map(|value| {
                value
                    .split(',')
                    .filter(|entry| !entry.is_empty())
                    .map(|entry| parse_bcsq_record(entry, bundle, annotation))
                    .collect::<Vec<_>>()
            })
            .filter(|records| !records.is_empty())
            .unwrap_or_else(|| vec![no_transcript_feature_record(bundle, annotation)]);
        results[index] = Some(EvidenceResult {
            source: source.clone(),
            status: EvidenceStatus::Found,
            records,
            message: None,
        });
    }
    results
        .into_iter()
        .enumerate()
        .map(|(index, result)| {
            result.ok_or_else(|| {
                DgwError::Tool(format!(
                    "bcftools csq omitted candidate record {} of {}",
                    index + 1,
                    variants.len()
                ))
            })
        })
        .collect()
}

fn parse_bcsq_record(
    annotation: &str,
    bundle: &ResourceBundle,
    resource: &crate::model::ConsequenceAnnotationResource,
) -> BTreeMap<String, String> {
    const FIELDS: [&str; 7] = [
        "effect",
        "geneName",
        "featureId",
        "transcriptBiotype",
        "strand",
        "aminoAcidChange",
        "dnaChange",
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
    let impact = record
        .get("effect")
        .map(|effect| strongest_consequence_impact(effect))
        .unwrap_or("MODIFIER");
    record.insert("impact".into(), impact.into());
    record.insert("engine".into(), "bcftools csq".into());
    record.insert("engineVersion".into(), bundle.bcftools_version.clone());
    record.insert("annotationRelease".into(), resource.release.clone());
    record.insert("raw".into(), annotation.into());
    record
}

fn no_transcript_feature_record(
    bundle: &ResourceBundle,
    resource: &crate::model::ConsequenceAnnotationResource,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("effect".into(), "no_transcript_feature".into()),
        ("impact".into(), "MODIFIER".into()),
        ("engine".into(), "bcftools csq".into()),
        ("engineVersion".into(), bundle.bcftools_version.clone()),
        ("annotationRelease".into(), resource.release.clone()),
        (
            "note".into(),
            "No overlapping transcript feature was reported by bcftools csq.".into(),
        ),
    ])
}

fn strongest_consequence_impact(effect: &str) -> &'static str {
    effect
        .split('&')
        .map(consequence_term_impact)
        .max_by_key(|impact| consequence_impact_rank(impact))
        .unwrap_or("MODIFIER")
}

fn consequence_term_impact(term: &str) -> &'static str {
    match term.to_ascii_lowercase().as_str() {
        "transcript_ablation"
        | "splice_acceptor"
        | "splice_donor"
        | "stop_gained"
        | "frameshift"
        | "stop_lost"
        | "start_lost"
        | "transcript_amplification" => "HIGH",
        "inframe_insertion" | "inframe_deletion" | "missense" | "protein_altering" => "MODERATE",
        "splice_region"
        | "incomplete_terminal_codon"
        | "start_retained"
        | "stop_retained"
        | "synonymous" => "LOW",
        _ => "MODIFIER",
    }
}

fn consequence_impact_rank(impact: &str) -> u8 {
    match impact {
        "HIGH" => 4,
        "MODERATE" => 3,
        "LOW" => 2,
        "MODIFIER" => 1,
        _ => 0,
    }
}

#[derive(Clone, Copy)]
enum ResourceKind {
    Vcf,
    Dbnsfp,
}

fn query_resource(
    tabix_path: &std::path::Path,
    resource: &IndexedResource,
    project_contig_style: &str,
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
    let resource_style = resource
        .contig_style
        .as_deref()
        .unwrap_or(project_contig_style);
    let resource_contig = translate_contig_style(&variant.contig, resource_style);
    let region = format!(
        "{}:{}-{}",
        resource_contig, variant.position, variant.position
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
                    && fields[0] == resource_contig
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

fn query_resource_signals_batch(
    tabix_path: &Path,
    resource: &IndexedResource,
    project_contig_style: &str,
    variants: &[VariantKey],
    kind: ResourceKind,
) -> Result<BTreeMap<VariantKey, BatchEvidenceSignal>> {
    let unavailable = if !tabix_path.is_file() {
        Some(format!(
            "tabix executable is missing: {}",
            tabix_path.display()
        ))
    } else if !resource.path.is_file() || !resource.index_path.is_file() {
        Some("data or index file is missing".into())
    } else {
        None
    };
    if unavailable.is_some() {
        return Ok(variants
            .iter()
            .cloned()
            .map(|variant| {
                (
                    variant,
                    BatchEvidenceSignal {
                        status: EvidenceStatus::ResourceUnavailable,
                        exact_match_count: 0,
                        impact_signal: None,
                        impact_label: None,
                        clinvar_classification: None,
                        no_transcript_feature: false,
                    },
                )
            })
            .collect());
    }

    let mut regions = tempfile::Builder::new()
        .prefix("dgw-track-profile-")
        .suffix(".bed")
        .tempfile()?;
    let mut loci = std::collections::BTreeSet::new();
    let mut candidates: BTreeMap<(String, u64), Vec<usize>> = BTreeMap::new();
    let resource_style = resource
        .contig_style
        .as_deref()
        .unwrap_or(project_contig_style);
    for (index, variant) in variants.iter().enumerate() {
        let contig = translate_contig_style(&variant.contig, resource_style);
        loci.insert((contig.clone(), variant.position));
        candidates
            .entry((contig, variant.position))
            .or_default()
            .push(index);
    }
    for (contig, position) in loci {
        // BED input makes coordinate semantics explicit for tabix -R.
        writeln!(
            regions,
            "{contig}\t{}\t{position}",
            position.saturating_sub(1)
        )?;
    }
    regions.flush()?;

    let mut child = Command::new(tabix_path)
        .arg("-R")
        .arg(regions.path())
        .arg(&resource.path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| DgwError::Tool("tabix batch stdout is unavailable".into()))?;
    let stderr = child.stderr.take();
    let stderr_reader = thread::spawn(move || {
        let mut message = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut message);
        }
        message
    });

    let mut signals: BTreeMap<VariantKey, BatchEvidenceSignal> = variants
        .iter()
        .cloned()
        .map(|variant| {
            (
                variant,
                BatchEvidenceSignal {
                    status: EvidenceStatus::NoExactMatch,
                    exact_match_count: 0,
                    impact_signal: None,
                    impact_label: None,
                    clinvar_classification: None,
                    no_transcript_feature: false,
                },
            )
        })
        .collect();
    for line in BufReader::new(stdout)
        .lines()
        .map_while(std::result::Result::ok)
    {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 4 {
            continue;
        }
        let Some(position) = fields.get(1).and_then(|value| value.parse::<u64>().ok()) else {
            continue;
        };
        let Some(indexes) = candidates.get(&(fields[0].to_owned(), position)) else {
            continue;
        };
        for index in indexes {
            let variant = &variants[*index];
            let exact = match kind {
                ResourceKind::Vcf => {
                    fields.len() >= 8
                        && fields[3].eq_ignore_ascii_case(&variant.reference)
                        && fields[4]
                            .split(',')
                            .any(|alternate| alternate.eq_ignore_ascii_case(&variant.alternate))
                }
                ResourceKind::Dbnsfp => {
                    fields[0].trim_start_matches("chr") == variant.contig.trim_start_matches("chr")
                        && fields[2].eq_ignore_ascii_case(&variant.reference)
                        && fields[3].eq_ignore_ascii_case(&variant.alternate)
                }
            };
            if exact {
                if let Some(signal) = signals.get_mut(variant) {
                    signal.status = EvidenceStatus::Found;
                    signal.exact_match_count = signal.exact_match_count.saturating_add(1);
                    if matches!(kind, ResourceKind::Vcf) && fields.len() >= 8 {
                        if let Some(classification) =
                            parse_info(fields[7]).into_iter().find_map(|(key, value)| {
                                key.eq_ignore_ascii_case("CLNSIG").then_some(value)
                            })
                        {
                            match &mut signal.clinvar_classification {
                                Some(existing)
                                    if !existing.split('|').any(|item| item == classification) =>
                                {
                                    existing.push('|');
                                    existing.push_str(&classification);
                                }
                                None => signal.clinvar_classification = Some(classification),
                                _ => {}
                            }
                        }
                    }
                }
            }
        }
    }
    let status = child.wait()?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        let message = stderr.trim();
        return Err(DgwError::Tool(if message.is_empty() {
            "tabix batch query failed".into()
        } else {
            format!("tabix batch query failed: {message}")
        }));
    }
    Ok(signals)
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
            contig_style: None,
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
            bcftools_path: "/configured/bcftools".into(),
            bcftools_version: "1.24".into(),
            bgzip_path: "/configured/bgzip".into(),
            tabix_path: "/configured/tabix".into(),
            dbnsfp: indexed_resource("dbnsfp"),
            clinvar: indexed_resource("clinvar"),
            cosmic: indexed_resource("cosmic"),
            gene_annotation: None,
            consequence_annotation: Some(crate::model::ConsequenceAnnotationResource {
                path: "/configured/genes.gff3.gz".into(),
                assembly: "GRCh37".into(),
                contig_style: "no_chr_prefix".into(),
                release: "Ensembl test".into(),
                source_url: "https://example.org/genes.gff3.gz".into(),
                license_label: "test".into(),
                fingerprint: None,
            }),
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
        assert_eq!(envelope.consequence.status, EvidenceStatus::NotComputed);
        assert_eq!(envelope.dbnsfp.status, EvidenceStatus::NotComputed);
        assert_eq!(envelope.cosmic.status, EvidenceStatus::NotComputed);
        assert_eq!(
            evidence_for_device(&envelope, "org.dgw.builtin.clinvar"),
            Some(&envelope.clinvar)
        );
    }

    #[test]
    fn consequence_annotation_is_part_of_availability() {
        let temporary = tempfile::tempdir().unwrap();
        let mut bundle = resource_bundle();
        bundle.bcftools_path = temporary.path().join("bcftools");
        bundle.reference_path = temporary.path().join("reference.fa.gz");
        let gff = temporary.path().join("genes.gff3.gz");
        bundle.consequence_annotation.as_mut().unwrap().path = gff.clone();
        std::fs::write(&bundle.bcftools_path, b"test").unwrap();
        std::fs::write(&bundle.reference_path, b"test").unwrap();
        assert!(consequence_resource_unavailable(&bundle)
            .is_some_and(|message| message.contains(&gff.display().to_string())));
        std::fs::write(gff, b"test").unwrap();
        assert!(consequence_resource_unavailable(&bundle).is_none());
    }

    #[test]
    fn parses_bcsq_fields_and_maps_impact() {
        let bundle = resource_bundle();
        let resource = bundle.consequence_annotation.as_ref().unwrap();
        let parsed = parse_bcsq_record(
            "missense&splice_region|BRAF|ENST1|protein_coding|+|600V>E|1799T>A",
            &bundle,
            resource,
        );
        assert_eq!(parsed.get("geneName").map(String::as_str), Some("BRAF"));
        assert_eq!(parsed.get("impact").map(String::as_str), Some("MODERATE"));
        assert_eq!(
            parsed.get("aminoAcidChange").map(String::as_str),
            Some("600V>E")
        );
    }

    #[test]
    fn no_transcript_feature_is_explicit_modifier_evidence() {
        let bundle = resource_bundle();
        let resource = bundle.consequence_annotation.as_ref().unwrap();
        let record = no_transcript_feature_record(&bundle, resource);
        let evidence = EvidenceResult {
            source: "Variant Consequences".into(),
            status: EvidenceStatus::Found,
            records: vec![record],
            message: None,
        };
        assert_eq!(
            evidence.records[0].get("effect").map(String::as_str),
            Some("no_transcript_feature")
        );
        assert_eq!(consequence_impact_signal(&evidence), Some(0.1));
    }

    #[test]
    fn consequence_signal_uses_the_strongest_transcript_impact() {
        let evidence = EvidenceResult {
            source: "Variant Consequences".into(),
            status: EvidenceStatus::Found,
            records: vec![
                BTreeMap::from([("impact".into(), "LOW".into())]),
                BTreeMap::from([("impact".into(), "HIGH".into())]),
            ],
            message: None,
        };
        assert_eq!(consequence_impact_signal(&evidence), Some(1.0));
    }

    #[test]
    fn batch_database_lookup_reports_resource_unavailable_per_exact_allele() {
        let variants = vec![variant()];
        let signals = query_resource_signals_batch(
            Path::new("/missing/tabix"),
            &indexed_resource("clinvar"),
            "no_chr_prefix",
            &variants,
            ResourceKind::Vcf,
        )
        .unwrap();
        assert_eq!(
            signals.get(&variants[0]).unwrap().status,
            EvidenceStatus::ResourceUnavailable
        );
    }
}
