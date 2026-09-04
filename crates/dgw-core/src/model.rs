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
    /// Contig convention used by this indexed file. Older v1 bundles omitted
    /// this field and therefore inherit the project/reference convention.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contig_style: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<FileFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneAnnotationResource {
    pub path: PathBuf,
    pub index_path: PathBuf,
    pub assembly: String,
    pub contig_style: String,
    pub release: String,
    pub source_url: String,
    pub license_label: String,
    #[serde(default)]
    pub fingerprint: Option<FileFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsequenceAnnotationResource {
    pub path: PathBuf,
    pub assembly: String,
    pub contig_style: String,
    pub release: String,
    pub source_url: String,
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
    pub bcftools_path: PathBuf,
    #[serde(default)]
    pub bcftools_version: String,
    pub bgzip_path: PathBuf,
    pub tabix_path: PathBuf,
    pub dbnsfp: IndexedResource,
    pub clinvar: IndexedResource,
    pub cosmic: IndexedResource,
    #[serde(default)]
    pub gene_annotation: Option<GeneAnnotationResource>,
    #[serde(default)]
    pub consequence_annotation: Option<ConsequenceAnnotationResource>,
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
    /// One-based GT slot carrying this ALT when a heterozygous genotype uses
    /// `/`. This preserves decomposed 1/2 as local 1/0 + 0/1 records without
    /// claiming that either slot is a known chromosome copy.
    #[serde(default)]
    pub unphased_slot: Option<u8>,
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
        /// Retains the original `/` genotype slot when an unphased allele is
        /// introduced from REF rather than replacing an active ALT.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unphased_slot: Option<u8>,
    },
    RestoreReference {
        #[serde(rename = "sourceKey", alias = "source_key")]
        source_key: VariantKey,
    },
    /// One visible, reversible history operation backed by normalized allele
    /// changes in `compound_mutation_changes`. The payload stays small even
    /// when a device changes tens of thousands of positions.
    CompoundMutationLayer {
        #[serde(rename = "layerId", alias = "layer_id")]
        layer_id: String,
        #[serde(rename = "positionCount", alias = "position_count")]
        position_count: u32,
        #[serde(rename = "changeCount", alias = "change_count")]
        change_count: u32,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copied_from_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VcfInspection {
    pub path: PathBuf,
    pub file_format: Option<String>,
    pub samples: Vec<String>,
    pub contigs: Vec<String>,
    pub input_contig_style: String,
    pub has_ann: bool,
    pub record_count: u64,
    pub pass_record_count: u64,
    pub non_pass_record_count: u64,
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
    #[serde(default)]
    pub unphased_slot: Option<u8>,
    pub origin: VariantOrigin,
    pub edit_ids: Vec<String>,
    pub source_key: Option<VariantKey>,
    pub source_info: BTreeMap<String, String>,
}

/// A validated allele edit that has not been persisted yet.
///
/// The preview identifier binds the edit to the target track head and its
/// current bypass state. Callers must present it again when applying the edit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlleleEditPreview {
    pub id: String,
    pub project_id: String,
    pub track_id: String,
    pub track_name: String,
    pub expected_head_state_id: String,
    pub haplotype: Haplotype,
    pub edit: EditKind,
    pub context: FocusContext,
    pub effective_before: Vec<EffectiveVariant>,
    pub effective_after: Vec<EffectiveVariant>,
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
    #[serde(alias = "snpeff")]
    pub consequence: EvidenceResult,
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

/// A bounded source-variant navigation row. Counts come from indexed SQLite
/// columns and do not materialize variant payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VariantContigSummary {
    pub contig: String,
    pub total: u64,
    pub min_position: u64,
    pub max_position: u64,
}

/// One occupied genomic interval nested beneath a contig in the source
/// browser. Empty equal-width intervals are omitted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VariantNavigationBin {
    pub contig: String,
    pub start: u64,
    pub end: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessProgress {
    pub operation: String,
    pub stage: String,
    pub message: String,
    pub step: u32,
    pub total_steps: u32,
}

impl ProcessProgress {
    pub fn new(
        operation: impl Into<String>,
        stage: impl Into<String>,
        message: impl Into<String>,
        step: u32,
        total_steps: u32,
    ) -> Self {
        Self {
            operation: operation.into(),
            stage: stage.into(),
            message: message.into(),
            step,
            total_steps,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundJobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// A persistent compute operation attached to one device and genome track.
/// Request/result payloads are device-owned protocol envelopes so new devices
/// can share the job infrastructure without changing the project schema.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJob {
    pub id: String,
    pub operation: String,
    pub device_id: String,
    pub track_id: String,
    pub status: BackgroundJobStatus,
    pub progress: u8,
    pub stage: String,
    pub message: String,
    pub worker_threads: u16,
    pub request: serde_json::Value,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Terminal status of an immutable scientific device-run record.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceRunStatus {
    Completed,
    Failed,
    Cancelled,
}

/// Write-once provenance for one device invocation. Unlike `BackgroundJob`,
/// this record is an audit artifact: it is never updated as work progresses
/// and is not removed when routine job history is cleared.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRunRecord {
    pub id: String,
    pub device_id: String,
    pub device_version: String,
    pub operation: String,
    pub track_id: String,
    pub input_state_id: String,
    pub input_fingerprint: String,
    pub selection: serde_json::Value,
    pub parameters: serde_json::Value,
    pub resource_bundle_fingerprint: String,
    pub resource_context: serde_json::Value,
    pub result_summary: serde_json::Value,
    #[serde(default)]
    pub output_edit_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compound_layer_id: Option<String>,
    pub status: DeviceRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub limitation: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompoundMutationChange {
    pub haplotype: Haplotype,
    pub edit: EditKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompoundMutationLayer {
    pub id: String,
    pub track_id: String,
    pub source_state_id: String,
    pub device_id: String,
    pub position_count: u32,
    pub change_count: u32,
    pub note: Option<String>,
    pub applied_edit_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// One independently evaluated allele-copy change from visible track history.
/// Compound layers expand to these records only inside the Rust backend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMutation {
    pub edit_id: String,
    pub haplotype: Haplotype,
    pub source_variant: VariantKey,
    pub current_variant: Option<VariantKey>,
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransportTargetKind {
    Variants,
    ActiveEdits,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransportAction {
    Locate,
    First,
    Last,
    Previous,
    Next,
}

/// Stable cursor used by bounded transport queries. Compound changes retain
/// their child ordinal so repeated edits at one locus remain navigable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransportCursor {
    pub source_key: VariantKey,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compound_ordinal: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransportTargetRequest {
    pub selection: VariantSelection,
    pub target_kind: TransportTargetKind,
    pub action: TransportAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<TransportCursor>,
    #[serde(default)]
    pub wrap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransportTarget {
    pub cursor: TransportCursor,
    pub source_key: VariantKey,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_variant: Option<EffectiveVariant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_id: Option<String>,
    pub locus_status: String,
    pub ordinal: u64,
    pub total: u64,
    pub wrapped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransportTargetResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<TransportTarget>,
    pub total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_selection_protocol_uses_camel_case_for_nested_fields() {
        let selection = VariantSelection::AllTrack {
            track_id: "working-track".into(),
            exclusions: Vec::new(),
        };
        let value = serde_json::to_value(&selection).unwrap();
        assert_eq!(value["kind"], "allTrack");
        assert_eq!(value["trackId"], "working-track");
        assert!(value.get("track_id").is_none());
        assert_eq!(
            serde_json::from_value::<VariantSelection>(value).unwrap(),
            selection
        );

        for value in [
            serde_json::json!({
                "kind": "explicit",
                "trackId": "working-track",
                "variants": []
            }),
            serde_json::json!({
                "kind": "interval",
                "trackId": "working-track",
                "contig": "1",
                "start": 1,
                "end": 10,
                "exclusions": []
            }),
        ] {
            serde_json::from_value::<VariantSelection>(value).unwrap();
        }
    }
}
