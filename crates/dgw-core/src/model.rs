use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub modified_unix: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexedResource {
    pub path: PathBuf,
    pub index_path: PathBuf,
    pub release: String,
    pub license_label: String,
    #[serde(default)]
    pub fingerprint: Option<FileFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBundle {
    pub schema_version: u32,
    pub id: String,
    pub assembly: String,
    pub contig_style: String,
    pub reference_path: PathBuf,
    pub reference_fai_path: PathBuf,
    pub reference_gzi_path: Option<PathBuf>,
    pub java_path: PathBuf,
    pub snpeff_jar_path: PathBuf,
    pub snpeff_config_path: Option<PathBuf>,
    pub snpeff_genome: String,
    pub snpeff_version: String,
    pub bcftools_path: PathBuf,
    pub bgzip_path: PathBuf,
    pub tabix_path: PathBuf,
    pub dbnsfp: IndexedResource,
    pub clinvar: IndexedResource,
    pub cosmic: IndexedResource,
    #[serde(default)]
    pub bundle_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct VariantKey {
    pub assembly: String,
    pub contig: String,
    pub position: u64,
    pub reference: String,
    pub alternate: String,
}

impl VariantKey {
    pub fn display(&self) -> String {
        format!(
            "{}:{} {}>{}",
            self.contig, self.position, self.reference, self.alternate
        )
    }

    pub fn stable_key(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.assembly, self.contig, self.position, self.reference, self.alternate
        )
    }

    pub fn end(&self) -> u64 {
        self.position + self.reference.len() as u64 - 1
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RootVariant {
    pub key: VariantKey,
    pub id: Option<String>,
    pub quality: Option<String>,
    pub filter: String,
    pub info: BTreeMap<String, String>,
    pub format_keys: Vec<String>,
    pub sample_values: Vec<String>,
    pub haplotype1_alt: bool,
    pub haplotype2_alt: bool,
    #[serde(default)]
    pub unphased_alt: bool,
    pub source_line: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Haplotype {
    One,
    Two,
    Unphased,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditKind {
    SetAllele {
        key: VariantKey,
        #[serde(rename = "sourceKey", alias = "source_key")]
        source_key: Option<VariantKey>,
    },
    RestoreReference {
        #[serde(rename = "sourceKey", alias = "source_key")]
        source_key: VariantKey,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditOperation {
    pub id: String,
    pub parent_state_id: String,
    pub haplotype: Haplotype,
    pub edit: EditKind,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenomeState {
    pub id: String,
    pub parent_id: Option<String>,
    pub edit_id: Option<String>,
    pub label: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenomeTrack {
    pub id: String,
    pub name: String,
    pub base_state_id: String,
    pub head_state_id: String,
    pub bypassed_edit_ids: Vec<String>,
    pub read_only: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FocusContext {
    pub contig: String,
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    #[serde(default)]
    pub active_track_id: String,
    pub current_state_id: String,
    pub bypassed_edit_ids: Vec<String>,
    pub a_state_id: Option<String>,
    pub b_state_id: Option<String>,
    pub focus: Option<FocusContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub schema_version: u32,
    pub project_id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub source_vcf: FileFingerprint,
    pub selected_sample: String,
    pub assembly: String,
    pub resource_bundle: ResourceBundle,
    pub resource_bundle_fingerprint: String,
    pub root_state_id: String,
    pub selected_vcf_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VcfInspection {
    pub path: PathBuf,
    pub file_format: Option<String>,
    pub samples: Vec<String>,
    pub contigs: Vec<String>,
    pub has_ann: bool,
    pub record_count: u64,
    pub supported_record_count: u64,
    pub skipped_unsupported_record_count: u64,
    pub biallelic: bool,
    pub sorted: bool,
    pub first_variant: Option<VariantKey>,
    pub last_variant: Option<VariantKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveVariant {
    pub key: VariantKey,
    pub haplotype1_alt: bool,
    pub haplotype2_alt: bool,
    #[serde(default)]
    pub unphased_alt: bool,
    pub origin: VariantOrigin,
    pub edit_ids: Vec<String>,
    pub source_key: Option<VariantKey>,
    pub source_info: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VariantOrigin {
    Observed,
    Edited,
    Created,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceStatus {
    Found,
    NoExactMatch,
    NotComputed,
    ResourceUnavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceResult {
    pub source: String,
    pub status: EvidenceStatus,
    pub records: Vec<BTreeMap<String, String>>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationResult {
    pub variant: VariantKey,
    pub cache_key: String,
    pub snpeff: EvidenceResult,
    pub dbnsfp: EvidenceResult,
    pub clinvar: EvidenceResult,
    pub cosmic: EvidenceResult,
    pub evaluated_at: DateTime<Utc>,
    pub resource_bundle_fingerprint: String,
    pub limitation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FocusView {
    pub context: FocusContext,
    pub contig_length: Option<u64>,
    pub reference_sequence: Option<String>,
    pub haplotype1_sequence: Option<String>,
    pub haplotype2_sequence: Option<String>,
    pub variants: Vec<EffectiveVariant>,
    pub states: Vec<GenomeState>,
    pub edits: Vec<EditOperation>,
    pub tracks: Vec<GenomeTrack>,
    pub active_track: GenomeTrack,
    pub workspace: WorkspaceSnapshot,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FocusFastaExport {
    pub fasta_path: PathBuf,
    pub uncertainty_path: Option<PathBuf>,
    pub sequence_records: u64,
    pub masked_unphased_alleles: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub manifest: ProjectManifest,
    pub workspace: WorkspaceSnapshot,
    pub tracks: Vec<GenomeTrack>,
    pub active_track: GenomeTrack,
    pub states: Vec<GenomeState>,
    pub variants: Vec<EffectiveVariant>,
    pub variant_count: u64,
    pub warnings: Vec<String>,
}

/// A bounded page from one genome track. Large projects must never require the
/// complete source VCF to cross the Tauri boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VariantPage {
    pub track_id: String,
    pub offset: u64,
    pub limit: u32,
    pub total: u64,
    pub variants: Vec<EffectiveVariant>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VariantDensityBin {
    pub contig: String,
    pub start: u64,
    pub end: u64,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VariantDensity {
    pub track_id: String,
    pub context: FocusContext,
    pub total: u64,
    pub bins: Vec<VariantDensityBin>,
}

/// Server-resolved selection. Explicit selections are ideal for small manual
/// gestures; interval/all-track selections stay compact even for very large
/// projects. Exclusions are exact normalized allele keys.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VariantSelection {
    Explicit {
        track_id: String,
        variants: Vec<VariantKey>,
    },
    Interval {
        track_id: String,
        contig: String,
        start: u64,
        end: u64,
        #[serde(default)]
        exclusions: Vec<VariantKey>,
    },
    AllTrack {
        track_id: String,
        #[serde(default)]
        exclusions: Vec<VariantKey>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectionResolution {
    pub track_id: String,
    pub total: u64,
    pub limit: u32,
    pub variants: Vec<VariantKey>,
    pub truncated: bool,
}
