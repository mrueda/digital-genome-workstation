use dgw_core::{
    plan_track_morph, AlleleEditPreview, BackgroundJob, BackgroundJobStatus, EditKind,
    EffectiveVariant, EvaluationService, FocusContext, FocusFastaExport, GeneSearchHit,
    GenomeState, GenomeTrack, Haplotype, LocalComputePool, MorphOrdering, OptimizerDirection,
    OptimizerMode, OptimizerObjective, OptimizerPreviewResult, OptimizerRequest, OptimizerWeights,
    Project, RandomizerPreviewResult, RandomizerRequest, SubstitutionPattern,
    TrackMorphPreviewResult, TrackMorphRequest, TrackVcfExport, VariantContigSummary, VariantKey,
    VariantPage, VariantSelection, CONSEQUENCE_DEVICE_ID, MAX_OPTIMIZER_EDITS,
    MAX_RANDOMIZER_POSITIONS, MAX_SATURATION_POSITIONS, MAX_SEQUENCE_FOCUS_BASES,
    TRACK_PROFILE_EVIDENCE_DEVICES,
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct OpenProjectRequest {
    #[schemars(description = "Absolute path to an existing .dgw project directory")]
    pub project_path: String,
}

#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
pub struct ProjectRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
pub struct VariantPageRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Track identifier; omit it to use the project's active track")]
    pub track_id: Option<String>,
    #[schemars(description = "Zero-based result offset")]
    pub offset: Option<u64>,
    #[schemars(description = "Number of variants to return; DGW clamps this to 1-200")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
pub struct GeneSearchRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Gene symbol or stable gene identifier")]
    pub query: String,
    #[schemars(description = "Maximum number of matches; DGW clamps this to 1-100")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
pub struct JobListRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Maximum number of recent jobs; DGW clamps this to 1-200")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
pub struct JobRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Persistent DGW background-job identifier")]
    pub job_id: String,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct TrackRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Exact genome-track identifier returned by list_tracks")]
    pub track_id: String,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct NamedTrackRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Exact genome-track identifier returned by list_tracks")]
    pub track_id: String,
    #[schemars(description = "Human-readable track name")]
    pub name: String,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChromosomeCopy {
    A,
    B,
    Unphased,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AlleleEditAction {
    SetAlternate,
    RestoreReference,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct VariantKeyInput {
    #[schemars(description = "Assembly identifier; omit it to use the project's assembly")]
    pub assembly: Option<String>,
    pub contig: String,
    #[schemars(description = "One-based VCF position")]
    pub position: u64,
    pub reference: String,
    pub alternate: String,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct AlleleEditRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Editable target track identifier returned by list_tracks")]
    pub track_id: String,
    #[schemars(description = "Current headStateId returned by list_tracks")]
    pub expected_head_state_id: String,
    #[schemars(description = "Chromosome copy carrying the selected source allele")]
    pub chromosome_copy: ChromosomeCopy,
    #[schemars(description = "Exact effective source allele returned by list_variants")]
    pub source_variant: VariantKeyInput,
    #[schemars(description = "Original one-based unphased GT slot, when present")]
    pub unphased_slot: Option<u8>,
    pub action: AlleleEditAction,
    #[schemars(description = "Replacement ALT for set_alternate; omit for restore_reference")]
    pub alternate: Option<String>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct ApplyAlleleEditRequest {
    #[serde(flatten)]
    pub edit: AlleleEditRequest,
    #[schemars(description = "Preview identifier returned by preview_allele_edit")]
    pub preview_id: String,
    #[schemars(description = "Optional history note")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MutationSubstitutionPattern {
    Uniform,
    TransitionOnly,
    TransversionOnly,
    TiTvMix,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MutationSelection {
    Explicit {
        variants: Vec<VariantKeyInput>,
    },
    Interval {
        contig: String,
        start: u64,
        end: u64,
        #[serde(default)]
        exclusions: Vec<VariantKeyInput>,
    },
    Gene {
        #[schemars(description = "Exact gene symbol or stable gene identifier")]
        query: String,
        #[serde(default)]
        exclusions: Vec<VariantKeyInput>,
    },
    WholeTrack {
        #[serde(default)]
        exclusions: Vec<VariantKeyInput>,
    },
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct StartMutationGeneratorPreviewRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Editable target track identifier")]
    pub track_id: String,
    #[schemars(description = "Current headStateId returned by list_tracks")]
    pub expected_head_state_id: String,
    pub selection: MutationSelection,
    #[schemars(description = "Percentage of eligible selected positions to change, from 0 to 100")]
    pub amount: u8,
    pub seed: u64,
    pub substitution_pattern: MutationSubstitutionPattern,
    #[schemars(description = "Transition percentage for ti_tv_mix; ignored by other patterns")]
    pub transition_probability: Option<u8>,
    #[schemars(description = "Maximum selected positions to resolve; defaults to 100000")]
    pub max_positions: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct ApplyMutationGeneratorPreviewRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Target track identifier used by the preview job")]
    pub track_id: String,
    #[schemars(description = "Track head captured when the preview job was started")]
    pub expected_head_state_id: String,
    #[schemars(description = "Completed Mutation Generator preview job identifier")]
    pub job_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GenomeMorphOrdering {
    Genomic,
    SeededRandom,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct StartGenomeMorphPreviewRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Editable source track identifier")]
    pub track_id: String,
    #[schemars(description = "Current headStateId of the editable source track")]
    pub expected_head_state_id: String,
    #[schemars(description = "Different project track whose effective genotype is the target")]
    pub target_track_id: String,
    #[schemars(description = "Current headStateId of the target track")]
    pub expected_target_head_state_id: String,
    #[schemars(description = "Percentage of differing whole positions to copy, from 0 to 100")]
    pub amount: u8,
    pub ordering: GenomeMorphOrdering,
    #[schemars(description = "Seed used only for seeded_random ordering")]
    pub seed: u64,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct ApplyGenomeMorphPreviewRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Editable source track identifier used by the preview job")]
    pub track_id: String,
    #[schemars(description = "Source-track head captured when the preview job was started")]
    pub expected_head_state_id: String,
    #[schemars(description = "Target track identifier used by the preview job")]
    pub target_track_id: String,
    #[schemars(description = "Target-track head captured when the preview job was started")]
    pub expected_target_head_state_id: String,
    #[schemars(description = "Completed Genome Morph preview job identifier")]
    pub job_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GenomeOptimizerMode {
    Saturation,
    Conservative,
}

#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GenomeOptimizerDirection {
    Minimize,
    Maximize,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct StartGenomeOptimizerPreviewRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Editable target track identifier")]
    pub track_id: String,
    #[schemars(description = "Current headStateId returned by list_tracks")]
    pub expected_head_state_id: String,
    pub selection: MutationSelection,
    #[schemars(
        description = "Saturation compares all non-reference SNV bases; Conservative only uses alleles present in the source genome"
    )]
    pub mode: GenomeOptimizerMode,
    pub direction: GenomeOptimizerDirection,
    #[schemars(description = "Maximum selected positions to change, from 1 to 100000")]
    pub max_changes: u32,
    #[schemars(description = "Maximum selected positions to resolve; defaults to 100000")]
    pub max_positions: Option<u32>,
    #[schemars(
        description = "Positive transcript-consequence weight for Saturation; defaults to 1 and is ignored by Conservative"
    )]
    pub impact_weight: Option<f64>,
    #[schemars(description = "Bounded local worker count; omit for available CPUs minus one")]
    pub worker_threads: Option<u16>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct ApplyGenomeOptimizerPreviewRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Target track identifier used by the preview job")]
    pub track_id: String,
    #[schemars(description = "Track head captured when the preview job was started")]
    pub expected_head_state_id: String,
    #[schemars(description = "Completed Genome Optimizer preview job identifier")]
    pub job_id: String,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct StartTrackProfilerRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Editable track identifier to analyze")]
    pub track_id: String,
    #[schemars(description = "Current headStateId returned by list_tracks")]
    pub expected_head_state_id: String,
    #[schemars(description = "Optional supported Evidence device IDs; omit to run all four")]
    pub device_ids: Option<Vec<String>>,
    #[schemars(description = "Bounded local worker count; omit for available CPUs minus one")]
    pub worker_threads: Option<u16>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct StartTrackVcfExportRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Track identifier returned by list_tracks")]
    pub track_id: String,
    #[schemars(description = "Current headStateId returned by list_tracks")]
    pub expected_head_state_id: String,
    #[schemars(
        description = "Absolute path for a new .vcf.gz file outside the .dgw package; existing files are never overwritten"
    )]
    pub output_path: String,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct ExportRegionFastaRequest {
    #[schemars(description = "Optional .dgw project path; omit it to use the active project")]
    pub project_path: Option<String>,
    #[schemars(description = "Track identifier returned by list_tracks")]
    pub track_id: String,
    #[schemars(description = "Current headStateId returned by list_tracks")]
    pub expected_head_state_id: String,
    pub contig: String,
    #[schemars(description = "One-based inclusive region start")]
    pub start: u64,
    #[schemars(description = "One-based inclusive region end; the span cannot exceed 50 kb")]
    pub end: u64,
    #[schemars(
        description = "Absolute path for a new FASTA file outside the .dgw package; existing files are never overwritten"
    )]
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project_path: String,
    pub project_id: String,
    pub name: String,
    pub assembly: String,
    pub selected_sample: String,
    pub active_track_id: String,
    pub track_count: usize,
    pub variant_count: u64,
    pub contig_count: usize,
    pub resource_bundle_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackListResult {
    project_path: String,
    active_track_id: String,
    tracks: Vec<GenomeTrack>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContigListResult {
    project_path: String,
    contigs: Vec<VariantContigSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VariantPageResult {
    project_path: String,
    page: VariantPage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneSearchResult {
    project_path: String,
    query: String,
    genes: Vec<GeneSearchHit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobListResult {
    project_path: String,
    jobs: Vec<JobSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobSummary {
    id: String,
    operation: String,
    device_id: String,
    track_id: String,
    status: BackgroundJobStatus,
    progress: u8,
    stage: String,
    message: String,
    worker_threads: u16,
    result_available: bool,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobResult {
    project_path: String,
    job: BackgroundJob,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackMutationResult {
    project_path: String,
    active_track_id: String,
    track: GenomeTrack,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlleleEditPreviewResult {
    project_path: String,
    preview: AlleleEditPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedAlleleEditResult {
    project_path: String,
    preview: AlleleEditPreview,
    state: GenomeState,
    track: GenomeTrack,
    effective_variants: Vec<EffectiveVariant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedBackgroundJobResult {
    project_path: String,
    job: BackgroundJob,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedMutationGeneratorResult {
    project_path: String,
    job_id: String,
    applied: bool,
    preview: RandomizerPreviewResult,
    state: Option<GenomeState>,
    track: GenomeTrack,
    active_mutation_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedGenomeMorphResult {
    project_path: String,
    job_id: String,
    applied: bool,
    preview: TrackMorphPreviewResult,
    state: Option<GenomeState>,
    track: GenomeTrack,
    active_mutation_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedGenomeOptimizerResult {
    project_path: String,
    job_id: String,
    applied: bool,
    preview: OptimizerPreviewResult,
    state: Option<GenomeState>,
    track: GenomeTrack,
    active_mutation_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegionFastaExportResult {
    project_path: String,
    track_id: String,
    state_id: String,
    region: FocusContext,
    export: FocusFastaExport,
}

#[derive(Clone)]
pub struct DgwMcpServer {
    tool_router: ToolRouter<Self>,
    active_project: Arc<RwLock<Option<PathBuf>>>,
    job_lock: Arc<Mutex<()>>,
    evaluation: Arc<EvaluationService>,
    compute_pool: Arc<LocalComputePool>,
}

impl Default for DgwMcpServer {
    fn default() -> Self {
        Self::new()
    }
}

impl DgwMcpServer {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
            active_project: Arc::new(RwLock::new(None)),
            job_lock: Arc::new(Mutex::new(())),
            evaluation: Arc::new(EvaluationService::new()),
            compute_pool: Arc::new(LocalComputePool::new()),
        }
    }

    fn resolve_project_path(&self, explicit: Option<String>) -> Result<PathBuf, String> {
        if let Some(path) = explicit.filter(|value| !value.trim().is_empty()) {
            return Ok(PathBuf::from(path));
        }
        self.active_project
            .read()
            .map_err(|_| "DGW MCP active-project state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| {
                "No DGW project is active. Call open_project first or provide project_path."
                    .to_owned()
            })
    }

    fn set_active_project(&self, path: PathBuf) -> Result<(), String> {
        *self
            .active_project
            .write()
            .map_err(|_| "DGW MCP active-project state is unavailable".to_owned())? = Some(path);
        Ok(())
    }

    async fn run_project<T, F>(
        &self,
        explicit: Option<String>,
        operation: F,
    ) -> Result<CallToolResult, McpError>
    where
        T: Serialize + Send + 'static,
        F: FnOnce(Project, String) -> Result<T, String> + Send + 'static,
    {
        let path = match self.resolve_project_path(explicit) {
            Ok(path) => path,
            Err(error) => return Ok(tool_error(error)),
        };
        let display_path = path.display().to_string();
        let outcome = tokio::task::spawn_blocking(move || {
            let project = Project::open(&path).map_err(|error| error.to_string())?;
            operation(project, display_path)
        })
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        match outcome {
            Ok(value) => structured(value),
            Err(error) => Ok(tool_error(error)),
        }
    }
}

#[tool_router(router = tool_router)]
impl DgwMcpServer {
    #[tool(
        description = "Open an existing DGW .dgw project and make it active for subsequent tools. This reads project metadata and does not modify genome tracks or edits."
    )]
    async fn open_project(
        &self,
        Parameters(request): Parameters<OpenProjectRequest>,
    ) -> Result<CallToolResult, McpError> {
        let path = PathBuf::from(request.project_path);
        let display_path = path.display().to_string();
        let outcome = tokio::task::spawn_blocking(move || {
            let project = Project::open(&path).map_err(|error| error.to_string())?;
            project_summary(&project, display_path)
        })
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        match outcome {
            Ok(summary) => {
                if let Err(error) = self.set_active_project(PathBuf::from(&summary.project_path)) {
                    return Ok(tool_error(error));
                }
                structured(summary)
            }
            Err(error) => Ok(tool_error(error)),
        }
    }

    #[tool(
        description = "Summarize a DGW project, including assembly, selected sample, active track, resource bundle, contig count, and imported variant count."
    )]
    async fn project_summary(
        &self,
        Parameters(request): Parameters<ProjectRequest>,
    ) -> Result<CallToolResult, McpError> {
        self.run_project(request.project_path, |project, path| {
            project_summary(&project, path)
        })
        .await
    }

    #[tool(
        description = "List the non-archived genome tracks in a DGW project and identify the active track. This does not return every variant."
    )]
    async fn list_tracks(
        &self,
        Parameters(request): Parameters<ProjectRequest>,
    ) -> Result<CallToolResult, McpError> {
        self.run_project(request.project_path, |project, project_path| {
            Ok(TrackListResult {
                project_path,
                active_track_id: project
                    .workspace()
                    .map_err(|error| error.to_string())?
                    .active_track_id,
                tracks: project.list_tracks().map_err(|error| error.to_string())?,
            })
        })
        .await
    }

    #[tool(
        description = "Select the active genome track. This changes only workspace focus; it does not alter alleles or track history."
    )]
    async fn select_track(
        &self,
        Parameters(request): Parameters<TrackRequest>,
    ) -> Result<CallToolResult, McpError> {
        validate_required("track_id", &request.track_id)?;
        self.run_project(request.project_path, move |project, project_path| {
            let track = project
                .select_track(&request.track_id)
                .map_err(|error| error.to_string())?;
            Ok(TrackMutationResult {
                project_path,
                active_track_id: track.id.clone(),
                track,
            })
        })
        .await
    }

    #[tool(
        description = "Duplicate a genome track as a new editable track and make the duplicate active. The source track and its history remain unchanged."
    )]
    async fn duplicate_track(
        &self,
        Parameters(request): Parameters<NamedTrackRequest>,
    ) -> Result<CallToolResult, McpError> {
        validate_required("track_id", &request.track_id)?;
        validate_required("name", &request.name)?;
        self.run_project(request.project_path, move |project, project_path| {
            let track = project
                .duplicate_track(&request.track_id, request.name)
                .map_err(|error| error.to_string())?;
            Ok(TrackMutationResult {
                project_path,
                active_track_id: track.id.clone(),
                track,
            })
        })
        .await
    }

    #[tool(
        description = "Rename one genome track. This changes track metadata only and leaves its allele state and history intact."
    )]
    async fn rename_track(
        &self,
        Parameters(request): Parameters<NamedTrackRequest>,
    ) -> Result<CallToolResult, McpError> {
        validate_required("track_id", &request.track_id)?;
        validate_required("name", &request.name)?;
        self.run_project(request.project_path, move |project, project_path| {
            let track = project
                .rename_track(&request.track_id, request.name)
                .map_err(|error| error.to_string())?;
            let active_track_id = project
                .workspace()
                .map_err(|error| error.to_string())?
                .active_track_id;
            Ok(TrackMutationResult {
                project_path,
                active_track_id,
                track,
            })
        })
        .await
    }

    #[tool(
        description = "Validate and normalize one manual allele change without modifying the project. Use an exact source allele from list_variants, then pass the returned previewId unchanged to apply_allele_edit."
    )]
    async fn preview_allele_edit(
        &self,
        Parameters(request): Parameters<AlleleEditRequest>,
    ) -> Result<CallToolResult, McpError> {
        if let Err(error) = validate_allele_request(&request) {
            return Ok(tool_error(error));
        }
        self.run_project(
            request.project_path.clone(),
            move |project, project_path| {
                let (haplotype, edit) = allele_edit_from_request(&project, &request)?;
                let preview = project
                    .preview_allele_edit(
                        &request.track_id,
                        &request.expected_head_state_id,
                        haplotype,
                        edit,
                    )
                    .map_err(|error| error.to_string())?;
                Ok(AlleleEditPreviewResult {
                    project_path,
                    preview,
                })
            },
        )
        .await
    }

    #[tool(
        description = "Apply one previously previewed allele change to its explicit editable track. DGW rejects stale previews, changed payloads, source-track edits, and invalid allele transitions."
    )]
    async fn apply_allele_edit(
        &self,
        Parameters(request): Parameters<ApplyAlleleEditRequest>,
    ) -> Result<CallToolResult, McpError> {
        if let Err(error) = validate_allele_request(&request.edit) {
            return Ok(tool_error(error));
        }
        if request.preview_id.trim().is_empty() {
            return Ok(tool_error("preview_id must not be empty"));
        }
        self.run_project(
            request.edit.project_path.clone(),
            move |project, project_path| {
                let (haplotype, edit) = allele_edit_from_request(&project, &request.edit)?;
                let (preview, state) = project
                    .apply_previewed_allele_edit(
                        &request.edit.track_id,
                        &request.edit.expected_head_state_id,
                        &request.preview_id,
                        haplotype,
                        edit,
                        request.note,
                    )
                    .map_err(|error| error.to_string())?;
                let keys = edit_keys(&preview.edit);
                let effective_variants = project
                    .effective_variants_for_track_at_loci(&request.edit.track_id, &keys)
                    .map_err(|error| error.to_string())?;
                Ok(AppliedAlleleEditResult {
                    project_path,
                    preview,
                    state,
                    track: project
                        .track(&request.edit.track_id)
                        .map_err(|error| error.to_string())?,
                    effective_variants,
                })
            },
        )
        .await
    }

    #[tool(
        description = "Start a persistent background preview for Mutation Generator Randomizer mode. Selection may be explicit alleles, a one-based interval, an exact gene, or the whole track. Poll the returned job with get_job; no track allele changes until apply_mutation_generator_preview."
    )]
    async fn start_mutation_generator_preview(
        &self,
        Parameters(request): Parameters<StartMutationGeneratorPreviewRequest>,
    ) -> Result<CallToolResult, McpError> {
        if let Err(error) = validate_mutation_generator_request(&request) {
            return Ok(tool_error(error));
        }
        let path = match self.resolve_project_path(request.project_path.clone()) {
            Ok(path) => path,
            Err(error) => return Ok(tool_error(error)),
        };
        let display_path = path.display().to_string();
        let worker_path = path.clone();
        let outcome = tokio::task::spawn_blocking(move || -> Result<BackgroundJob, String> {
            let project = Project::open(&path).map_err(|error| error.to_string())?;
            let track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            if track.read_only {
                return Err(String::from(
                    "the source genome track is read-only; duplicate it before making changes",
                ));
            }
            if track.head_state_id != request.expected_head_state_id {
                return Err("the selected track head changed; inspect the track and retry".into());
            }
            let selection =
                mutation_selection_from_request(&project, &request.track_id, request.selection)?;
            let randomizer = RandomizerRequest {
                selected_variants: Vec::new(),
                amount: request.amount,
                seed: request.seed,
                substitution_pattern: substitution_pattern(request.substitution_pattern),
                transition_probability: request.transition_probability.unwrap_or(67),
            };
            let max_positions = request
                .max_positions
                .unwrap_or(MAX_RANDOMIZER_POSITIONS as u32);
            let now = chrono::Utc::now();
            let job = BackgroundJob {
                id: Uuid::new_v4().to_string(),
                operation: "mutationGeneratorPreview".into(),
                device_id: "org.dgw.builtin.mutation-generator".into(),
                track_id: request.track_id,
                status: BackgroundJobStatus::Queued,
                progress: 0,
                stage: "queued".into(),
                message: "Waiting for the MCP background compute slot".into(),
                worker_threads: 1,
                request: json!({
                    "request": randomizer,
                    "selection": selection,
                    "selectionLimit": max_positions,
                    "sourceStateId": request.expected_head_state_id,
                    "host": "mcp"
                }),
                result: None,
                error: None,
                created_at: now,
                updated_at: now,
            };
            project
                .save_background_job(&job)
                .map_err(|error| error.to_string())?;
            Ok(job)
        })
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        let job = match outcome {
            Ok(job) => job,
            Err(error) => return Ok(tool_error(error)),
        };
        let job_id = job.id.clone();
        let job_lock = Arc::clone(&self.job_lock);
        tokio::task::spawn_blocking(move || {
            let _guard = job_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = execute_mutation_generator_job(&worker_path, &job_id);
        });
        structured(StartedBackgroundJobResult {
            project_path: display_path,
            job,
        })
    }

    #[tool(
        description = "Apply a completed Mutation Generator preview job as one compact reversible mutation layer. A no-op preview returns applied=false. Stale or cross-track previews are rejected."
    )]
    async fn apply_mutation_generator_preview(
        &self,
        Parameters(request): Parameters<ApplyMutationGeneratorPreviewRequest>,
    ) -> Result<CallToolResult, McpError> {
        if request.track_id.trim().is_empty()
            || request.expected_head_state_id.trim().is_empty()
            || request.job_id.trim().is_empty()
        {
            return Ok(tool_error(
                "track_id, expected_head_state_id, and job_id must not be empty",
            ));
        }
        self.run_project(request.project_path, move |project, project_path| {
            let job = project
                .background_job(&request.job_id)
                .map_err(|error| error.to_string())?;
            if job.operation != "mutationGeneratorPreview" {
                return Err("job is not a Mutation Generator preview".into());
            }
            if job.track_id != request.track_id {
                return Err("preview job belongs to a different track".into());
            }
            let source_state_id = job
                .request
                .get("sourceStateId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "preview job has no source state".to_owned())?;
            if source_state_id != request.expected_head_state_id {
                return Err("expected_head_state_id does not match the preview job".into());
            }
            if job.status != BackgroundJobStatus::Completed {
                return Err(format!(
                    "preview job is {:?}; wait for completion before applying it",
                    job.status
                ));
            }
            let preview: RandomizerPreviewResult = serde_json::from_value(
                job.result
                    .clone()
                    .ok_or_else(|| "completed preview job has no result".to_owned())?,
            )
            .map_err(|error| error.to_string())?;
            if project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?
                .head_state_id
                != request.expected_head_state_id
            {
                return Err("the target track changed after preview; run it again".into());
            }
            let state = match preview.compound_layer_id.as_deref() {
                Some(layer_id) => Some(
                    project
                        .apply_compound_mutation_layer(&request.track_id, layer_id)
                        .map_err(|error| error.to_string())?,
                ),
                None => None,
            };
            let track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            let active_mutation_count = project
                .active_track_mutations(&request.track_id)
                .map_err(|error| error.to_string())?
                .len();
            Ok(AppliedMutationGeneratorResult {
                project_path,
                job_id: request.job_id,
                applied: state.is_some(),
                preview,
                state,
                track,
                active_mutation_count,
            })
        })
        .await
    }

    #[tool(
        description = "Start a persistent Genome Morph preview between two compatible tracks in the active project. The source and target heads are explicit; whole differing positions are copied in genomic or seeded-random order. Poll with get_job, then apply explicitly."
    )]
    async fn start_genome_morph_preview(
        &self,
        Parameters(request): Parameters<StartGenomeMorphPreviewRequest>,
    ) -> Result<CallToolResult, McpError> {
        if let Err(error) = validate_genome_morph_request(&request) {
            return Ok(tool_error(error));
        }
        let path = match self.resolve_project_path(request.project_path.clone()) {
            Ok(path) => path,
            Err(error) => return Ok(tool_error(error)),
        };
        let display_path = path.display().to_string();
        let worker_path = path.clone();
        let outcome = tokio::task::spawn_blocking(move || -> Result<BackgroundJob, String> {
            let project = Project::open(&path).map_err(|error| error.to_string())?;
            let source_track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            if source_track.read_only {
                return Err(String::from(
                    "the source genome track is read-only; duplicate it before morphing",
                ));
            }
            if source_track.head_state_id != request.expected_head_state_id {
                return Err("the source track head changed; inspect the tracks and retry".into());
            }
            let target_track = project
                .track(&request.target_track_id)
                .map_err(|error| error.to_string())?;
            if target_track.head_state_id != request.expected_target_head_state_id {
                return Err("the target track head changed; inspect the tracks and retry".into());
            }
            let morph = TrackMorphRequest {
                amount: request.amount,
                ordering: match request.ordering {
                    GenomeMorphOrdering::Genomic => MorphOrdering::Genomic,
                    GenomeMorphOrdering::SeededRandom => MorphOrdering::SeededRandom,
                },
                seed: request.seed,
            };
            let now = chrono::Utc::now();
            let job = BackgroundJob {
                id: Uuid::new_v4().to_string(),
                operation: "trackMorphPreview".into(),
                device_id: "org.dgw.builtin.genome-morph".into(),
                track_id: request.track_id,
                status: BackgroundJobStatus::Queued,
                progress: 0,
                stage: "queued".into(),
                message: "Waiting for the MCP background compute slot".into(),
                worker_threads: 1,
                request: json!({
                    "sourceStateId": request.expected_head_state_id,
                    "sourceBypassedEditIds": source_track.bypassed_edit_ids,
                    "targetTrackId": request.target_track_id,
                    "targetStateId": request.expected_target_head_state_id,
                    "targetBypassedEditIds": target_track.bypassed_edit_ids,
                    "morph": morph,
                    "host": "mcp"
                }),
                result: None,
                error: None,
                created_at: now,
                updated_at: now,
            };
            project
                .save_background_job(&job)
                .map_err(|error| error.to_string())?;
            Ok(job)
        })
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        let job = match outcome {
            Ok(job) => job,
            Err(error) => return Ok(tool_error(error)),
        };
        let job_id = job.id.clone();
        let job_lock = Arc::clone(&self.job_lock);
        tokio::task::spawn_blocking(move || {
            let _guard = job_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = execute_genome_morph_job(&worker_path, &job_id);
        });
        structured(StartedBackgroundJobResult {
            project_path: display_path,
            job,
        })
    }

    #[tool(
        description = "Apply a completed Genome Morph preview as one compact reversible mutation layer on its source track. DGW rejects changed source or target states, bypass changes, cross-track previews, and repeated application."
    )]
    async fn apply_genome_morph_preview(
        &self,
        Parameters(request): Parameters<ApplyGenomeMorphPreviewRequest>,
    ) -> Result<CallToolResult, McpError> {
        if request.track_id.trim().is_empty()
            || request.expected_head_state_id.trim().is_empty()
            || request.target_track_id.trim().is_empty()
            || request.expected_target_head_state_id.trim().is_empty()
            || request.job_id.trim().is_empty()
        {
            return Ok(tool_error(
                "track_id, expected_head_state_id, target_track_id, expected_target_head_state_id, and job_id must not be empty",
            ));
        }
        self.run_project(request.project_path, move |project, project_path| {
            let job = project
                .background_job(&request.job_id)
                .map_err(|error| error.to_string())?;
            if job.operation != "trackMorphPreview" {
                return Err("job is not a Genome Morph preview".into());
            }
            if job.track_id != request.track_id {
                return Err("preview job belongs to a different source track".into());
            }
            let target_track_id = job
                .request
                .get("targetTrackId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "preview job has no target track".to_owned())?;
            if target_track_id != request.target_track_id {
                return Err("preview job belongs to a different target track".into());
            }
            let source_state_id = job
                .request
                .get("sourceStateId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "preview job has no source state".to_owned())?;
            let target_state_id = job
                .request
                .get("targetStateId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "preview job has no target state".to_owned())?;
            if source_state_id != request.expected_head_state_id
                || target_state_id != request.expected_target_head_state_id
            {
                return Err("expected track heads do not match the preview job".into());
            }
            if job.status != BackgroundJobStatus::Completed {
                return Err(format!(
                    "preview job is {:?}; wait for completion before applying it",
                    job.status
                ));
            }
            ensure_morph_tracks_unchanged(&project, &job)?;
            let preview: TrackMorphPreviewResult = serde_json::from_value(
                job.result
                    .clone()
                    .ok_or_else(|| "completed preview job has no result".to_owned())?,
            )
            .map_err(|error| error.to_string())?;
            let state = match preview.compound_layer_id.as_deref() {
                Some(layer_id) => Some(
                    project
                        .apply_compound_mutation_layer(&request.track_id, layer_id)
                        .map_err(|error| error.to_string())?,
                ),
                None => None,
            };
            let track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            let active_mutation_count = project
                .active_track_mutations(&request.track_id)
                .map_err(|error| error.to_string())?
                .len();
            Ok(AppliedGenomeMorphResult {
                project_path,
                job_id: request.job_id,
                applied: state.is_some(),
                preview,
                state,
                track,
                active_mutation_count,
            })
        })
        .await
    }

    #[tool(
        description = "Start a persistent Genome Optimizer preview for an explicit track head. Saturation compares live-predicted non-reference SNV alleles with a fixed ClinVar pathogenicity guard; Conservative only adds or removes alleles already present in the source genome. Poll with get_job; no track alleles change until apply_genome_optimizer_preview."
    )]
    async fn start_genome_optimizer_preview(
        &self,
        Parameters(request): Parameters<StartGenomeOptimizerPreviewRequest>,
    ) -> Result<CallToolResult, McpError> {
        if let Err(error) = validate_genome_optimizer_request(&request) {
            return Ok(tool_error(error));
        }
        let path = match self.resolve_project_path(request.project_path.clone()) {
            Ok(path) => path,
            Err(error) => return Ok(tool_error(error)),
        };
        let display_path = path.display().to_string();
        let worker_path = path.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            let project = Project::open(&path).map_err(|error| error.to_string())?;
            let track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            if track.read_only {
                return Err(String::from(
                    "the source genome track is read-only; duplicate it before optimizing",
                ));
            }
            if track.head_state_id != request.expected_head_state_id {
                return Err("the selected track head changed; inspect the track and retry".into());
            }
            let optimizer = optimizer_request_from_mcp(&request);
            let selection =
                mutation_selection_from_request(&project, &request.track_id, request.selection)?;
            let focus = optimizer_focus(&project, &selection)?;
            let max_positions = request
                .max_positions
                .unwrap_or(MAX_SATURATION_POSITIONS as u32);
            let worker_threads = request
                .worker_threads
                .unwrap_or_else(default_worker_threads);
            let now = chrono::Utc::now();
            let job = BackgroundJob {
                id: Uuid::new_v4().to_string(),
                operation: "genomeOptimizer".into(),
                device_id: "org.dgw.builtin.genome-optimizer".into(),
                track_id: request.track_id,
                status: BackgroundJobStatus::Queued,
                progress: 0,
                stage: "queued".into(),
                message: "Waiting for the MCP background compute slot".into(),
                worker_threads,
                request: json!({
                    "optimizer": optimizer,
                    "selection": selection,
                    "selectionLimit": max_positions,
                    "focus": focus,
                    "sourceStateId": request.expected_head_state_id,
                    "bypassedEditIds": track.bypassed_edit_ids,
                    "host": "mcp"
                }),
                result: None,
                error: None,
                created_at: now,
                updated_at: now,
            };
            project
                .save_background_job(&job)
                .map_err(|error| error.to_string())?;
            Ok(job)
        })
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        let job = match outcome {
            Ok(job) => job,
            Err(error) => return Ok(tool_error(error)),
        };
        let job_id = job.id.clone();
        let job_lock = Arc::clone(&self.job_lock);
        let evaluation = Arc::clone(&self.evaluation);
        let compute_pool = Arc::clone(&self.compute_pool);
        tokio::task::spawn_blocking(move || {
            let _guard = job_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = execute_optimizer_job(&worker_path, &job_id, &evaluation, &compute_pool);
        });
        structured(StartedBackgroundJobResult {
            project_path: display_path,
            job,
        })
    }

    #[tool(
        description = "Apply a completed Genome Optimizer preview as one compact reversible mutation layer. A no-op preview returns applied=false. Stale, already-applied, or cross-track previews are rejected."
    )]
    async fn apply_genome_optimizer_preview(
        &self,
        Parameters(request): Parameters<ApplyGenomeOptimizerPreviewRequest>,
    ) -> Result<CallToolResult, McpError> {
        if request.track_id.trim().is_empty()
            || request.expected_head_state_id.trim().is_empty()
            || request.job_id.trim().is_empty()
        {
            return Ok(tool_error(
                "track_id, expected_head_state_id, and job_id must not be empty",
            ));
        }
        self.run_project(request.project_path, move |project, project_path| {
            let job = project
                .background_job(&request.job_id)
                .map_err(|error| error.to_string())?;
            if job.operation != "genomeOptimizer" {
                return Err("job is not a Genome Optimizer preview".into());
            }
            if job.track_id != request.track_id {
                return Err("preview job belongs to a different track".into());
            }
            let source_state_id = job
                .request
                .get("sourceStateId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "preview job has no source state".to_owned())?;
            if source_state_id != request.expected_head_state_id {
                return Err("expected_head_state_id does not match the preview job".into());
            }
            if job.status != BackgroundJobStatus::Completed {
                return Err(format!(
                    "preview job is {:?}; wait for completion before applying it",
                    job.status
                ));
            }
            let current_track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            let captured_bypasses: Vec<String> = serde_json::from_value(
                job.request
                    .get("bypassedEditIds")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            )
            .map_err(|error| error.to_string())?;
            if current_track.head_state_id != request.expected_head_state_id
                || current_track.bypassed_edit_ids != captured_bypasses
            {
                return Err(
                    "the target track changed after the optimizer preview; run it again".into(),
                );
            }
            let preview: OptimizerPreviewResult = serde_json::from_value(
                job.result
                    .clone()
                    .ok_or_else(|| "completed preview job has no result".to_owned())?,
            )
            .map_err(|error| error.to_string())?;
            let state = match preview.compound_layer_id.as_deref() {
                Some(layer_id) => Some(
                    project
                        .apply_compound_mutation_layer(&request.track_id, layer_id)
                        .map_err(|error| error.to_string())?,
                ),
                None => None,
            };
            let track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            let active_mutation_count = project
                .active_track_mutations(&request.track_id)
                .map_err(|error| error.to_string())?
                .len();
            Ok(AppliedGenomeOptimizerResult {
                project_path,
                job_id: request.job_id,
                applied: state.is_some(),
                preview,
                state,
                track,
                active_mutation_count,
            })
        })
        .await
    }

    #[tool(
        description = "Start persistent Track Profiler analysis for an explicit track head. The job evaluates active mutations with selected exact-allele Evidence devices on a bounded local Rayon pool. Omit device_ids to use all four supported Evidence devices and poll progress with get_job."
    )]
    async fn start_track_profiler(
        &self,
        Parameters(request): Parameters<StartTrackProfilerRequest>,
    ) -> Result<CallToolResult, McpError> {
        if request.track_id.trim().is_empty() || request.expected_head_state_id.trim().is_empty() {
            return Ok(tool_error(
                "track_id and expected_head_state_id must not be empty",
            ));
        }
        if request
            .worker_threads
            .is_some_and(|threads| threads == 0 || threads > 256)
        {
            return Ok(tool_error("worker_threads must be between 1 and 256"));
        }
        let requested_devices = request.device_ids.unwrap_or_else(|| {
            TRACK_PROFILE_EVIDENCE_DEVICES
                .iter()
                .map(|device| (*device).to_owned())
                .collect()
        });
        let device_ids = dgw_core::normalized_track_profile_devices(&requested_devices);
        let unsupported: Vec<_> = requested_devices
            .iter()
            .filter(|device| !TRACK_PROFILE_EVIDENCE_DEVICES.contains(&device.as_str()))
            .cloned()
            .collect();
        if !unsupported.is_empty() {
            return Ok(tool_error(format!(
                "unsupported Track Profiler Evidence devices: {}",
                unsupported.join(", ")
            )));
        }
        if device_ids.is_empty() {
            return Ok(tool_error(
                "Track Profiler requires at least one Evidence device",
            ));
        }
        let path = match self.resolve_project_path(request.project_path) {
            Ok(path) => path,
            Err(error) => return Ok(tool_error(error)),
        };
        let display_path = path.display().to_string();
        let worker_path = path.clone();
        let track_id = request.track_id;
        let expected_head_state_id = request.expected_head_state_id;
        let worker_threads = request
            .worker_threads
            .unwrap_or_else(default_worker_threads);
        let outcome = tokio::task::spawn_blocking(move || {
            let project = Project::open(&path).map_err(|error| error.to_string())?;
            let track = project
                .track(&track_id)
                .map_err(|error| error.to_string())?;
            if track.head_state_id != expected_head_state_id {
                return Err(String::from(
                    "the selected track head changed; inspect the track and retry",
                ));
            }
            let active_mutations = project
                .active_track_mutations(&track_id)
                .map_err(|error| error.to_string())?;
            if active_mutations.is_empty() {
                return Err("the selected track has no active mutations to profile".into());
            }
            let fingerprint = project
                .track_profile_input_fingerprint(&track_id, &device_ids)
                .map_err(|error| error.to_string())?;
            let now = chrono::Utc::now();
            let job = BackgroundJob {
                id: Uuid::new_v4().to_string(),
                operation: "trackEvidenceProfile".into(),
                device_id: "org.dgw.builtin.track-profiler".into(),
                track_id: track_id.clone(),
                status: BackgroundJobStatus::Queued,
                progress: 0,
                stage: "queued".into(),
                message: "Waiting for the MCP background compute slot".into(),
                worker_threads,
                request: json!({
                    "stateId": expected_head_state_id,
                    "bypassedEditIds": track.bypassed_edit_ids,
                    "deviceIds": device_ids,
                    "profileInputFingerprint": fingerprint,
                    "host": "mcp"
                }),
                result: None,
                error: None,
                created_at: now,
                updated_at: now,
            };
            project
                .save_background_job(&job)
                .map_err(|error| error.to_string())?;
            Ok(job)
        })
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        let job = match outcome {
            Ok(job) => job,
            Err(error) => return Ok(tool_error(error)),
        };
        let job_id = job.id.clone();
        let job_lock = Arc::clone(&self.job_lock);
        let evaluation = Arc::clone(&self.evaluation);
        let compute_pool = Arc::clone(&self.compute_pool);
        tokio::task::spawn_blocking(move || {
            let _guard = job_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = execute_track_profiler_job(&worker_path, &job_id, &evaluation, &compute_pool);
        });
        structured(StartedBackgroundJobResult {
            project_path: display_path,
            job,
        })
    }

    #[tool(
        description = "Start a persistent whole-track VCF export job from an explicit track head. The output is a new BGZF/CSI VCF with DGW evidence, device-run, and provenance sidecars. The absolute destination must be outside the .dgw package and no existing artifact is overwritten. Poll with get_job."
    )]
    async fn start_track_vcf_export(
        &self,
        Parameters(request): Parameters<StartTrackVcfExportRequest>,
    ) -> Result<CallToolResult, McpError> {
        if request.track_id.trim().is_empty()
            || request.expected_head_state_id.trim().is_empty()
            || request.output_path.trim().is_empty()
        {
            return Ok(tool_error(
                "track_id, expected_head_state_id, and output_path must not be empty",
            ));
        }
        if !PathBuf::from(&request.output_path).is_absolute() {
            return Ok(tool_error("output_path must be absolute"));
        }
        let path = match self.resolve_project_path(request.project_path) {
            Ok(path) => path,
            Err(error) => return Ok(tool_error(error)),
        };
        let display_path = path.display().to_string();
        let worker_path = path.clone();
        let outcome = tokio::task::spawn_blocking(move || -> Result<BackgroundJob, String> {
            let project = Project::open(&path).map_err(|error| error.to_string())?;
            let track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            if track.head_state_id != request.expected_head_state_id {
                return Err("the selected track head changed; inspect the track and retry".into());
            }
            let now = chrono::Utc::now();
            let job = BackgroundJob {
                id: Uuid::new_v4().to_string(),
                operation: "trackVcfExport".into(),
                device_id: "org.dgw.host.track-vcf-export".into(),
                track_id: request.track_id,
                status: BackgroundJobStatus::Queued,
                progress: 0,
                stage: "queued".into(),
                message: "Waiting for the MCP background compute slot".into(),
                worker_threads: 1,
                request: json!({
                    "stateId": request.expected_head_state_id,
                    "bypassedEditIds": track.bypassed_edit_ids,
                    "outputPath": request.output_path,
                    "host": "mcp"
                }),
                result: None,
                error: None,
                created_at: now,
                updated_at: now,
            };
            project
                .save_background_job(&job)
                .map_err(|error| error.to_string())?;
            Ok(job)
        })
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        let job = match outcome {
            Ok(job) => job,
            Err(error) => return Ok(tool_error(error)),
        };
        let job_id = job.id.clone();
        let job_lock = Arc::clone(&self.job_lock);
        tokio::task::spawn_blocking(move || {
            let _guard = job_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = execute_track_vcf_export_job(&worker_path, &job_id);
        });
        structured(StartedBackgroundJobResult {
            project_path: display_path,
            job,
        })
    }

    #[tool(
        description = "Export a one-based reference interval of at most 50 kb as three FASTA records: reference, chromosome copy A, and chromosome copy B. Unphased alleles are masked and reported in an optional TSV sidecar. The explicit track head must still match; the absolute destination must be outside the .dgw package and is never overwritten."
    )]
    async fn export_region_fasta(
        &self,
        Parameters(request): Parameters<ExportRegionFastaRequest>,
    ) -> Result<CallToolResult, McpError> {
        if request.track_id.trim().is_empty()
            || request.expected_head_state_id.trim().is_empty()
            || request.contig.trim().is_empty()
            || request.output_path.trim().is_empty()
        {
            return Ok(tool_error(
                "track_id, expected_head_state_id, contig, and output_path must not be empty",
            ));
        }
        if request.start == 0
            || request.end < request.start
            || request.end.saturating_sub(request.start).saturating_add(1)
                > MAX_SEQUENCE_FOCUS_BASES
        {
            return Ok(tool_error(
                "region must be a valid one-based inclusive interval no wider than 50 kb",
            ));
        }
        if !PathBuf::from(&request.output_path).is_absolute() {
            return Ok(tool_error("output_path must be absolute"));
        }
        self.run_project(request.project_path, move |project, project_path| {
            let track = project
                .track(&request.track_id)
                .map_err(|error| error.to_string())?;
            if track.head_state_id != request.expected_head_state_id {
                return Err("the selected track head changed; inspect the track and retry".into());
            }
            let region = FocusContext {
                contig: request.contig,
                start: request.start,
                end: request.end,
            };
            let export = project
                .export_focus_fasta_at_head(
                    &request.track_id,
                    &request.expected_head_state_id,
                    &track.bypassed_edit_ids,
                    region.clone(),
                    PathBuf::from(request.output_path),
                )
                .map_err(|error| error.to_string())?;
            Ok(RegionFastaExportResult {
                project_path,
                track_id: request.track_id,
                state_id: request.expected_head_state_id,
                region,
                export,
            })
        })
        .await
    }

    #[tool(
        description = "List contigs represented in the imported VCF, with variant counts and one-based coordinate bounds. Use this before requesting bounded variant pages."
    )]
    async fn list_variant_contigs(
        &self,
        Parameters(request): Parameters<ProjectRequest>,
    ) -> Result<CallToolResult, McpError> {
        self.run_project(request.project_path, |project, project_path| {
            Ok(ContigListResult {
                project_path,
                contigs: project
                    .variant_contig_summaries()
                    .map_err(|error| error.to_string())?,
            })
        })
        .await
    }

    #[tool(
        description = "Return one bounded page of effective variants for a genome track. Results use one-based VCF positions and never materialize the complete project at once."
    )]
    async fn list_variants(
        &self,
        Parameters(request): Parameters<VariantPageRequest>,
    ) -> Result<CallToolResult, McpError> {
        self.run_project(request.project_path, move |project, project_path| {
            let track_id = match request.track_id {
                Some(track_id) if !track_id.trim().is_empty() => track_id,
                _ => {
                    project
                        .active_track()
                        .map_err(|error| error.to_string())?
                        .id
                }
            };
            Ok(VariantPageResult {
                project_path,
                page: project
                    .variant_page(
                        &track_id,
                        request.offset.unwrap_or(0),
                        request.limit.unwrap_or(50),
                    )
                    .map_err(|error| error.to_string())?,
            })
        })
        .await
    }

    #[tool(
        description = "Search the assembly-matched gene index by symbol or stable identifier and report each gene's coordinates plus overlapping imported source-variant count."
    )]
    async fn search_genes(
        &self,
        Parameters(request): Parameters<GeneSearchRequest>,
    ) -> Result<CallToolResult, McpError> {
        if request.query.trim().is_empty() {
            return Ok(tool_error("query must not be empty"));
        }
        self.run_project(request.project_path, move |project, project_path| {
            let query = request.query;
            let genes = project
                .search_genes(&query, request.limit.unwrap_or(12))
                .map_err(|error| error.to_string())?;
            Ok(GeneSearchResult {
                project_path,
                query,
                genes,
            })
        })
        .await
    }

    #[tool(
        description = "List bounded summaries of recent persistent DGW background jobs. Use get_job to retrieve one complete request or result. This does not start or cancel work."
    )]
    async fn list_jobs(
        &self,
        Parameters(request): Parameters<JobListRequest>,
    ) -> Result<CallToolResult, McpError> {
        self.run_project(request.project_path, move |project, project_path| {
            Ok(JobListResult {
                project_path,
                jobs: project
                    .list_background_jobs(request.limit.unwrap_or(50))
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .map(JobSummary::from)
                    .collect(),
            })
        })
        .await
    }

    #[tool(
        description = "Read one persistent DGW background job by identifier, including progress and any completed result or failure."
    )]
    async fn get_job(
        &self,
        Parameters(request): Parameters<JobRequest>,
    ) -> Result<CallToolResult, McpError> {
        if request.job_id.trim().is_empty() {
            return Ok(tool_error("job_id must not be empty"));
        }
        self.run_project(request.project_path, move |project, project_path| {
            Ok(JobResult {
                project_path,
                job: project
                    .background_job(&request.job_id)
                    .map_err(|error| error.to_string())?,
            })
        })
        .await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for DgwMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "dgw-mcp".into(),
                title: Some("Digital Genome Workstation".into()),
                version: env!("CARGO_PKG_VERSION").into(),
                icons: None,
                website_url: Some(
                    "https://github.com/mrueda/digital-genome-workstation".into(),
                ),
            },
            instructions: Some(
                "Call open_project with an existing .dgw directory first. Read operations are bounded; list_variants returns at most 200 variants per call. Positions are one-based. Genome changes require an editable track and its current head. Manual changes use preview_allele_edit before apply_allele_edit. Mutation Generator, Genome Morph, and Genome Optimizer each use a background preview, get_job until completed, and an explicit apply tool. Genome Morph also requires a different target track and its current head. Analyze an applied head with start_track_profiler. Export a captured head with start_track_vcf_export or export_region_fasta; exports require new absolute paths outside the project package."
                    .into(),
            ),
            ..Default::default()
        }
    }
}

fn project_summary(project: &Project, project_path: String) -> Result<ProjectSummary, String> {
    let tracks = project.list_tracks().map_err(|error| error.to_string())?;
    let workspace = project.workspace().map_err(|error| error.to_string())?;
    let contigs = project
        .variant_contig_summaries()
        .map_err(|error| error.to_string())?;
    let manifest = project.manifest();
    Ok(ProjectSummary {
        project_path,
        project_id: manifest.project_id.clone(),
        name: manifest.name.clone(),
        assembly: manifest.assembly.clone(),
        selected_sample: manifest.selected_sample.clone(),
        active_track_id: workspace.active_track_id,
        track_count: tracks.len(),
        variant_count: contigs.iter().map(|contig| contig.total).sum(),
        contig_count: contigs.len(),
        resource_bundle_id: manifest.resource_bundle.id.clone(),
    })
}

fn structured<T: Serialize>(value: T) -> Result<CallToolResult, McpError> {
    let value = serde_json::to_value(value)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    Ok(CallToolResult::structured(value))
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::structured_error(json!({ "error": message.into() }))
}

fn validate_required(field: &str, value: &str) -> Result<(), McpError> {
    if value.trim().is_empty() {
        return Err(McpError::invalid_params(
            format!("{field} must not be empty"),
            None,
        ));
    }
    Ok(())
}

fn validate_allele_request(request: &AlleleEditRequest) -> Result<(), String> {
    for (field, value) in [
        ("track_id", request.track_id.as_str()),
        (
            "expected_head_state_id",
            request.expected_head_state_id.as_str(),
        ),
        (
            "source_variant.contig",
            request.source_variant.contig.as_str(),
        ),
        (
            "source_variant.reference",
            request.source_variant.reference.as_str(),
        ),
        (
            "source_variant.alternate",
            request.source_variant.alternate.as_str(),
        ),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{field} must not be empty"));
        }
    }
    if request.source_variant.position == 0 {
        return Err("source_variant.position must be one-based".into());
    }
    match request.action {
        AlleleEditAction::SetAlternate => {
            if request
                .alternate
                .as_deref()
                .is_none_or(|alternate| alternate.trim().is_empty())
            {
                return Err("alternate is required for set_alternate".into());
            }
        }
        AlleleEditAction::RestoreReference if request.alternate.is_some() => {
            return Err("alternate must be omitted for restore_reference".into());
        }
        AlleleEditAction::RestoreReference => {}
    }
    Ok(())
}

fn allele_edit_from_request(
    project: &Project,
    request: &AlleleEditRequest,
) -> Result<(Haplotype, EditKind), String> {
    let assembly = project.manifest().assembly.clone();
    if request
        .source_variant
        .assembly
        .as_deref()
        .is_some_and(|provided| provided != assembly)
    {
        return Err(format!(
            "source_variant assembly does not match project assembly {assembly}"
        ));
    }
    let source_key = VariantKey {
        assembly: assembly.clone(),
        contig: request.source_variant.contig.clone(),
        position: request.source_variant.position,
        reference: request.source_variant.reference.to_ascii_uppercase(),
        alternate: request.source_variant.alternate.to_ascii_uppercase(),
    };
    let haplotype = match request.chromosome_copy {
        ChromosomeCopy::A => Haplotype::One,
        ChromosomeCopy::B => Haplotype::Two,
        ChromosomeCopy::Unphased => Haplotype::Unphased,
    };
    let edit = match request.action {
        AlleleEditAction::RestoreReference => EditKind::RestoreReference { source_key },
        AlleleEditAction::SetAlternate => EditKind::SetAllele {
            key: VariantKey {
                assembly,
                contig: source_key.contig.clone(),
                position: source_key.position,
                reference: source_key.reference.clone(),
                alternate: request
                    .alternate
                    .as_deref()
                    .expect("validated set_alternate")
                    .to_ascii_uppercase(),
            },
            source_key: Some(source_key),
            unphased_slot: request.unphased_slot,
        },
    };
    Ok((haplotype, edit))
}

fn edit_keys(edit: &EditKind) -> Vec<VariantKey> {
    match edit {
        EditKind::SetAllele {
            key, source_key, ..
        } => {
            let mut keys = vec![key.clone()];
            if let Some(source_key) = source_key {
                keys.push(source_key.clone());
            }
            keys
        }
        EditKind::RestoreReference { source_key } => vec![source_key.clone()],
        EditKind::CompoundMutationLayer { .. } => Vec::new(),
    }
}

fn validate_mutation_generator_request(
    request: &StartMutationGeneratorPreviewRequest,
) -> Result<(), String> {
    if request.track_id.trim().is_empty() || request.expected_head_state_id.trim().is_empty() {
        return Err("track_id and expected_head_state_id must not be empty".into());
    }
    if request.amount > 100 {
        return Err("amount must be between 0 and 100".into());
    }
    if request
        .transition_probability
        .is_some_and(|value| value > 100)
    {
        return Err("transition_probability must be between 0 and 100".into());
    }
    if request
        .max_positions
        .is_some_and(|value| value == 0 || value as usize > MAX_RANDOMIZER_POSITIONS)
    {
        return Err(format!(
            "max_positions must be between 1 and {MAX_RANDOMIZER_POSITIONS}"
        ));
    }
    Ok(())
}

fn validate_genome_morph_request(request: &StartGenomeMorphPreviewRequest) -> Result<(), String> {
    if request.track_id.trim().is_empty()
        || request.expected_head_state_id.trim().is_empty()
        || request.target_track_id.trim().is_empty()
        || request.expected_target_head_state_id.trim().is_empty()
    {
        return Err(
            "track_id, expected_head_state_id, target_track_id, and expected_target_head_state_id must not be empty"
                .into(),
        );
    }
    if request.track_id == request.target_track_id {
        return Err("Genome Morph requires a different target track".into());
    }
    if request.amount > 100 {
        return Err("amount must be between 0 and 100".into());
    }
    Ok(())
}

fn ensure_morph_tracks_unchanged(project: &Project, job: &BackgroundJob) -> Result<(), String> {
    let source_state_id = job
        .request
        .get("sourceStateId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Genome Morph job has no source state".to_owned())?;
    let source_bypasses: Vec<String> = serde_json::from_value(
        job.request
            .get("sourceBypassedEditIds")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|error| error.to_string())?;
    let target_track_id = job
        .request
        .get("targetTrackId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Genome Morph job has no target track".to_owned())?;
    let target_state_id = job
        .request
        .get("targetStateId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Genome Morph job has no target state".to_owned())?;
    let target_bypasses: Vec<String> = serde_json::from_value(
        job.request
            .get("targetBypassedEditIds")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|error| error.to_string())?;
    let source_track = project
        .track(&job.track_id)
        .map_err(|error| error.to_string())?;
    let target_track = project
        .track(target_track_id)
        .map_err(|error| error.to_string())?;
    if source_track.head_state_id != source_state_id
        || source_track.bypassed_edit_ids != source_bypasses
    {
        return Err("the Genome Morph source track changed; run the preview again".into());
    }
    if target_track.head_state_id != target_state_id
        || target_track.bypassed_edit_ids != target_bypasses
    {
        return Err("the Genome Morph target track changed; run the preview again".into());
    }
    Ok(())
}

fn validate_genome_optimizer_request(
    request: &StartGenomeOptimizerPreviewRequest,
) -> Result<(), String> {
    if request.track_id.trim().is_empty() || request.expected_head_state_id.trim().is_empty() {
        return Err("track_id and expected_head_state_id must not be empty".into());
    }
    if request.max_changes == 0 || request.max_changes > MAX_OPTIMIZER_EDITS {
        return Err(format!(
            "max_changes must be between 1 and {MAX_OPTIMIZER_EDITS}"
        ));
    }
    if request
        .max_positions
        .is_some_and(|value| value == 0 || value as usize > MAX_SATURATION_POSITIONS)
    {
        return Err(format!(
            "max_positions must be between 1 and {MAX_SATURATION_POSITIONS}"
        ));
    }
    if request
        .worker_threads
        .is_some_and(|threads| threads == 0 || threads > 256)
    {
        return Err("worker_threads must be between 1 and 256".into());
    }
    if let Some(weight) = request.impact_weight {
        if !weight.is_finite() || !(0.0..=1_000.0).contains(&weight) {
            return Err("impact_weight must be finite and between 0 and 1000".into());
        }
        if matches!(request.mode, GenomeOptimizerMode::Saturation) && weight == 0.0 {
            return Err("Saturation requires a positive impact_weight".into());
        }
    }
    Ok(())
}

fn optimizer_request_from_mcp(request: &StartGenomeOptimizerPreviewRequest) -> OptimizerRequest {
    let mode = match request.mode {
        GenomeOptimizerMode::Saturation => OptimizerMode::Saturation,
        GenomeOptimizerMode::Conservative => OptimizerMode::Conservative,
    };
    let direction = match request.direction {
        GenomeOptimizerDirection::Minimize => OptimizerDirection::Minimize,
        GenomeOptimizerDirection::Maximize => OptimizerDirection::Maximize,
    };
    let saturation = mode == OptimizerMode::Saturation;
    OptimizerRequest {
        mode,
        objective: if saturation {
            OptimizerObjective::PredictedImpactBurden
        } else {
            OptimizerObjective::AlternateAlleleBurden
        },
        direction,
        max_edits: request.max_changes,
        weights: OptimizerWeights {
            impact: if saturation {
                request.impact_weight.unwrap_or(1.0)
            } else {
                0.0
            },
            clinvar: 0.0,
            source_evidence: 0.0,
        },
        selected_variants: Vec::new(),
        evidence_device_ids: if saturation {
            vec![
                CONSEQUENCE_DEVICE_ID.into(),
                "org.dgw.builtin.clinvar".into(),
            ]
        } else if direction == OptimizerDirection::Maximize {
            vec!["org.dgw.builtin.clinvar".into()]
        } else {
            Vec::new()
        },
    }
}

fn optimizer_focus(
    project: &Project,
    selection: &VariantSelection,
) -> Result<FocusContext, String> {
    match selection {
        VariantSelection::Explicit { variants, .. } => variants
            .first()
            .map(|variant| FocusContext {
                contig: variant.contig.clone(),
                start: variant.position,
                end: variant.end(),
            })
            .ok_or_else(|| "explicit selection must contain at least one variant".into()),
        VariantSelection::Interval {
            contig, start, end, ..
        } => Ok(FocusContext {
            contig: contig.clone(),
            start: *start,
            end: *end,
        }),
        VariantSelection::AllTrack { .. } => project
            .variant_contig_summaries()
            .map_err(|error| error.to_string())?
            .into_iter()
            .next()
            .map(|contig| FocusContext {
                contig: contig.contig,
                start: contig.min_position,
                end: contig.max_position,
            })
            .ok_or_else(|| "the project contains no selectable variants".into()),
    }
}

fn substitution_pattern(pattern: MutationSubstitutionPattern) -> SubstitutionPattern {
    match pattern {
        MutationSubstitutionPattern::Uniform => SubstitutionPattern::Uniform,
        MutationSubstitutionPattern::TransitionOnly => SubstitutionPattern::TransitionOnly,
        MutationSubstitutionPattern::TransversionOnly => SubstitutionPattern::TransversionOnly,
        MutationSubstitutionPattern::TiTvMix => SubstitutionPattern::TiTvMix,
    }
}

fn variant_key_from_input(project: &Project, input: VariantKeyInput) -> Result<VariantKey, String> {
    let assembly = project.manifest().assembly.clone();
    if input
        .assembly
        .as_deref()
        .is_some_and(|provided| provided != assembly)
    {
        return Err(format!(
            "variant assembly does not match project assembly {assembly}"
        ));
    }
    if input.position == 0
        || input.contig.trim().is_empty()
        || input.reference.trim().is_empty()
        || input.alternate.trim().is_empty()
    {
        return Err("selection variants require contig, one-based position, REF, and ALT".into());
    }
    Ok(VariantKey {
        assembly,
        contig: input.contig,
        position: input.position,
        reference: input.reference.to_ascii_uppercase(),
        alternate: input.alternate.to_ascii_uppercase(),
    })
}

fn mutation_selection_from_request(
    project: &Project,
    track_id: &str,
    selection: MutationSelection,
) -> Result<VariantSelection, String> {
    let map_keys = |values: Vec<VariantKeyInput>| {
        values
            .into_iter()
            .map(|value| variant_key_from_input(project, value))
            .collect::<Result<Vec<_>, _>>()
    };
    match selection {
        MutationSelection::Explicit { variants } => {
            if variants.is_empty() {
                return Err("explicit selection must contain at least one variant".into());
            }
            Ok(VariantSelection::Explicit {
                track_id: track_id.into(),
                variants: map_keys(variants)?,
            })
        }
        MutationSelection::Interval {
            contig,
            start,
            end,
            exclusions,
        } => {
            if contig.trim().is_empty() || start == 0 || end < start {
                return Err("interval selection requires a valid one-based inclusive range".into());
            }
            Ok(VariantSelection::Interval {
                track_id: track_id.into(),
                contig,
                start,
                end,
                exclusions: map_keys(exclusions)?,
            })
        }
        MutationSelection::Gene { query, exclusions } => {
            if query.trim().is_empty() {
                return Err("gene query must not be empty".into());
            }
            let exact: Vec<_> = project
                .search_genes(&query, 100)
                .map_err(|error| error.to_string())?
                .into_iter()
                .filter(|hit| {
                    hit.locus.symbol.eq_ignore_ascii_case(query.trim())
                        || hit.locus.gene_id.eq_ignore_ascii_case(query.trim())
                })
                .collect();
            if exact.is_empty() {
                return Err(format!(
                    "no exact gene symbol or stable identifier matched {query}"
                ));
            }
            if exact.len() > 1 {
                return Err(format!(
                    "gene query {query} is ambiguous; use a stable gene identifier"
                ));
            }
            let gene = &exact[0].locus;
            Ok(VariantSelection::Interval {
                track_id: track_id.into(),
                contig: gene.contig.clone(),
                start: gene.start,
                end: gene.end,
                exclusions: map_keys(exclusions)?,
            })
        }
        MutationSelection::WholeTrack { exclusions } => Ok(VariantSelection::AllTrack {
            track_id: track_id.into(),
            exclusions: map_keys(exclusions)?,
        }),
    }
}

fn update_persistent_job(
    project: &Project,
    job: &mut BackgroundJob,
    status: BackgroundJobStatus,
    progress: u8,
    stage: &str,
    message: impl Into<String>,
) -> Result<(), String> {
    update_background_job(project, job, status, progress, stage, message)?;
    project
        .persist_terminal_device_run(job)
        .map_err(|error| error.to_string())
}

fn update_background_job(
    project: &Project,
    job: &mut BackgroundJob,
    status: BackgroundJobStatus,
    progress: u8,
    stage: &str,
    message: impl Into<String>,
) -> Result<(), String> {
    job.status = status;
    job.progress = progress.min(100);
    job.stage = stage.into();
    job.message = message.into();
    job.updated_at = chrono::Utc::now();
    project
        .save_background_job(job)
        .map_err(|error| error.to_string())
}

fn execute_mutation_generator_job(project_path: &PathBuf, job_id: &str) -> Result<(), String> {
    let project = Project::open(project_path).map_err(|error| error.to_string())?;
    let mut job = project
        .background_job(job_id)
        .map_err(|error| error.to_string())?;
    update_persistent_job(
        &project,
        &mut job,
        BackgroundJobStatus::Running,
        10,
        "selection",
        "Resolving the selected variants",
    )?;
    let outcome = (|| -> Result<RandomizerPreviewResult, String> {
        let request: RandomizerRequest = serde_json::from_value(
            job.request
                .get("request")
                .cloned()
                .ok_or_else(|| "preview job has no Randomizer request".to_owned())?,
        )
        .map_err(|error| error.to_string())?;
        let selection: VariantSelection = serde_json::from_value(
            job.request
                .get("selection")
                .cloned()
                .ok_or_else(|| "preview job has no variant selection".to_owned())?,
        )
        .map_err(|error| error.to_string())?;
        let source_state_id = job
            .request
            .get("sourceStateId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "preview job has no source state".to_owned())?;
        let selection_limit = job
            .request
            .get("selectionLimit")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok());
        update_persistent_job(
            &project,
            &mut job,
            BackgroundJobStatus::Running,
            70,
            "planning",
            "Planning and staging the mutation layer",
        )?;
        project
            .prepare_randomizer_preview(
                &job.track_id,
                &source_state_id,
                request,
                Some(&selection),
                selection_limit,
                true,
            )
            .map_err(|error| error.to_string())
    })();
    match outcome {
        Ok(preview) => {
            job.result = Some(serde_json::to_value(preview).map_err(|error| error.to_string())?);
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Completed,
                100,
                "completed",
                "Mutation Generator preview completed",
            )
        }
        Err(error) => {
            job.error = Some(error.clone());
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Failed,
                100,
                "failed",
                error,
            )
        }
    }
}

fn execute_genome_morph_job(project_path: &PathBuf, job_id: &str) -> Result<(), String> {
    let project = Project::open(project_path).map_err(|error| error.to_string())?;
    let mut job = project
        .background_job(job_id)
        .map_err(|error| error.to_string())?;
    update_persistent_job(
        &project,
        &mut job,
        BackgroundJobStatus::Running,
        10,
        "source",
        "Reading the source track's effective allele state",
    )?;
    let outcome = (|| -> Result<TrackMorphPreviewResult, String> {
        ensure_morph_tracks_unchanged(&project, &job)?;
        let source_state_id = job
            .request
            .get("sourceStateId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Genome Morph job has no source state".to_owned())?;
        let target_track_id = job
            .request
            .get("targetTrackId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Genome Morph job has no target track".to_owned())?;
        let target_state_id = job
            .request
            .get("targetStateId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Genome Morph job has no target state".to_owned())?;
        let request: TrackMorphRequest = serde_json::from_value(
            job.request
                .get("morph")
                .cloned()
                .ok_or_else(|| "Genome Morph job has no request".to_owned())?,
        )
        .map_err(|error| error.to_string())?;
        let source_track = project
            .track(&job.track_id)
            .map_err(|error| error.to_string())?;
        let target_track = project
            .track(&target_track_id)
            .map_err(|error| error.to_string())?;
        let source = project
            .effective_variants_for_track(&job.track_id)
            .map_err(|error| error.to_string())?;

        update_persistent_job(
            &project,
            &mut job,
            BackgroundJobStatus::Running,
            35,
            "target",
            "Reading the target track's effective allele state",
        )?;
        let target = project
            .effective_variants_for_track(&target_track_id)
            .map_err(|error| error.to_string())?;

        update_persistent_job(
            &project,
            &mut job,
            BackgroundJobStatus::Running,
            60,
            "difference",
            format!("Comparing {} with {}", source_track.name, target_track.name),
        )?;
        let plan =
            plan_track_morph(&source, &target, &request).map_err(|error| error.to_string())?;
        ensure_morph_tracks_unchanged(&project, &job)?;
        let mut compound_layer_id = None;
        if !plan.changes.is_empty() {
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Running,
                82,
                "staging",
                format!(
                    "Storing {} allele changes across {} positions",
                    plan.generated_edits, plan.selected_positions
                ),
            )?;
            let note = format!(
                "Genome Morph · {} → {} · {}% · {} · {} positions",
                source_track.name,
                target_track.name,
                request.amount,
                request.ordering.label(),
                plan.selected_positions
            );
            let layer = project
                .stage_morph_layer(
                    &source_track,
                    &target_track,
                    plan.selected_positions,
                    &plan.changes,
                    Some(note),
                )
                .map_err(|error| error.to_string())?;
            compound_layer_id = Some(layer.id);
        }
        Ok(TrackMorphPreviewResult {
            source_track_id: job.track_id.clone(),
            source_state_id,
            target_track_id,
            target_state_id,
            amount: request.amount,
            differing_positions: plan.differing_positions,
            differing_alleles: plan.differing_alleles,
            selected_positions: plan.selected_positions,
            generated_edits: plan.generated_edits,
            no_op_reason: plan.no_op_reason,
            limitation: plan.limitation,
            compound_layer_id,
        })
    })();
    match outcome {
        Ok(preview) => {
            let message = preview.no_op_reason.clone().unwrap_or_else(|| {
                format!(
                    "Morph preview prepared {} changes across {} positions",
                    preview.generated_edits, preview.selected_positions
                )
            });
            job.result = Some(serde_json::to_value(preview).map_err(|error| error.to_string())?);
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Completed,
                100,
                "completed",
                message,
            )
        }
        Err(error) => {
            job.error = Some(error.clone());
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Failed,
                100,
                "failed",
                error,
            )
        }
    }
}

fn execute_optimizer_job(
    project_path: &PathBuf,
    job_id: &str,
    evaluation: &EvaluationService,
    compute_pool: &LocalComputePool,
) -> Result<(), String> {
    let project = Project::open(project_path).map_err(|error| error.to_string())?;
    let mut job = project
        .background_job(job_id)
        .map_err(|error| error.to_string())?;
    let request: OptimizerRequest = serde_json::from_value(
        job.request
            .get("optimizer")
            .cloned()
            .ok_or_else(|| "optimizer job has no request".to_owned())?,
    )
    .map_err(|error| error.to_string())?;
    let selection: VariantSelection = serde_json::from_value(
        job.request
            .get("selection")
            .cloned()
            .ok_or_else(|| "optimizer job has no variant selection".to_owned())?,
    )
    .map_err(|error| error.to_string())?;
    let focus: FocusContext = serde_json::from_value(
        job.request
            .get("focus")
            .cloned()
            .ok_or_else(|| "optimizer job has no focus context".to_owned())?,
    )
    .map_err(|error| error.to_string())?;
    let source_state_id = job
        .request
        .get("sourceStateId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "optimizer job has no source state".to_owned())?;
    let bypassed_edit_ids: Vec<String> = serde_json::from_value(
        job.request
            .get("bypassedEditIds")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|error| error.to_string())?;
    let selection_limit = job
        .request
        .get("selectionLimit")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    let track_id = job.track_id.clone();
    let worker_threads = job.worker_threads;
    let outcome = compute_pool.run(worker_threads, || {
        dgw_core::prepare_optimizer_preview(
            evaluation,
            &project,
            &track_id,
            &source_state_id,
            &bypassed_edit_ids,
            &focus,
            request,
            Some(&selection),
            selection_limit,
            usize::from(worker_threads),
            |progress, stage, message| {
                update_persistent_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Running,
                    progress,
                    stage,
                    message,
                )
            },
            || false,
        )
    });
    match outcome {
        Ok(preview) => {
            let message = preview.no_op_reason.clone().unwrap_or_else(|| {
                format!(
                    "Optimizer prepared {} changes across {} positions",
                    preview.generated_edits, preview.changed_positions
                )
            });
            job.result = Some(serde_json::to_value(preview).map_err(|error| error.to_string())?);
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Completed,
                100,
                "completed",
                message,
            )
        }
        Err(error) => {
            job.error = Some(error.clone());
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Failed,
                100,
                "failed",
                error,
            )
        }
    }
}

fn execute_track_vcf_export_job(project_path: &PathBuf, job_id: &str) -> Result<(), String> {
    let project = Project::open(project_path).map_err(|error| error.to_string())?;
    let mut job = project
        .background_job(job_id)
        .map_err(|error| error.to_string())?;
    let state_id = job
        .request
        .get("stateId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "VCF export job has no captured track state".to_owned())?;
    let bypassed_edit_ids: Vec<String> = serde_json::from_value(
        job.request
            .get("bypassedEditIds")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|error| error.to_string())?;
    let output_path = job
        .request
        .get("outputPath")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "VCF export job has no output path".to_owned())?;
    update_background_job(
        &project,
        &mut job,
        BackgroundJobStatus::Running,
        10,
        "render",
        "Rendering the captured track and writing provenance sidecars",
    )?;
    let outcome: Result<TrackVcfExport, String> = project
        .export_track_vcf_at_head(&job.track_id, &state_id, &bypassed_edit_ids, output_path)
        .map_err(|error| error.to_string());
    match outcome {
        Ok(export) => {
            let message = format!("Exported track VCF to {}", export.vcf_path.display());
            job.result = Some(serde_json::to_value(export).map_err(|error| error.to_string())?);
            update_background_job(
                &project,
                &mut job,
                BackgroundJobStatus::Completed,
                100,
                "completed",
                message,
            )
        }
        Err(error) => {
            job.error = Some(error.clone());
            update_background_job(
                &project,
                &mut job,
                BackgroundJobStatus::Failed,
                100,
                "failed",
                error,
            )
        }
    }
}

fn default_worker_threads() -> u16 {
    std::thread::available_parallelism()
        .map(|count| count.get().saturating_sub(1).max(1))
        .unwrap_or(1)
        .min(256) as u16
}

fn evidence_device_label(device_id: &str) -> &'static str {
    match device_id {
        dgw_core::CONSEQUENCE_DEVICE_ID => "Consequence Predictor",
        "org.dgw.builtin.clinvar" => "ClinVar",
        "org.dgw.builtin.cosmic" => "COSMIC",
        _ => "Evidence",
    }
}

fn execute_track_profiler_job(
    project_path: &PathBuf,
    job_id: &str,
    evaluation: &EvaluationService,
    compute_pool: &LocalComputePool,
) -> Result<(), String> {
    let project = Project::open(project_path).map_err(|error| error.to_string())?;
    let mut job = project
        .background_job(job_id)
        .map_err(|error| error.to_string())?;
    let device_ids: Vec<String> = serde_json::from_value(
        job.request
            .get("deviceIds")
            .cloned()
            .ok_or_else(|| "Track Profiler job has no device list".to_owned())?,
    )
    .map_err(|error| error.to_string())?;
    let expected_state_id = job
        .request
        .get("stateId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Track Profiler job has no captured state".to_owned())?;
    let expected_fingerprint = job
        .request
        .get("profileInputFingerprint")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Track Profiler job has no input fingerprint".to_owned())?;
    let current_track = project
        .track(&job.track_id)
        .map_err(|error| error.to_string())?;
    if current_track.head_state_id != expected_state_id
        || project
            .track_profile_input_fingerprint(&job.track_id, &device_ids)
            .map_err(|error| error.to_string())?
            != expected_fingerprint
    {
        let error = "the track changed before Evidence profiling started; run it again".to_owned();
        job.error = Some(error.clone());
        return update_persistent_job(
            &project,
            &mut job,
            BackgroundJobStatus::Failed,
            100,
            "failed",
            error,
        );
    }
    update_persistent_job(
        &project,
        &mut job,
        BackgroundJobStatus::Running,
        5,
        "mutations",
        "Expanding active track mutations",
    )?;

    let mut last_reported = BTreeMap::<String, usize>::new();
    let mut device_progress = BTreeMap::<String, (usize, usize)>::new();
    let track_id = job.track_id.clone();
    let worker_threads = job.worker_threads;
    let outcome = dgw_core::profile_track_parallel_with_threads(
        compute_pool,
        evaluation,
        &project,
        &track_id,
        &device_ids,
        worker_threads,
        |device_id, processed, total| {
            device_progress.insert(device_id.to_owned(), (processed, total));
            let last = last_reported.entry(device_id.to_owned()).or_default();
            if processed != 0 && processed != total && processed.saturating_sub(*last) < 250 {
                return Ok(());
            }
            *last = processed;
            let completed: f64 = device_ids
                .iter()
                .map(|candidate| {
                    device_progress.get(candidate).map_or(0.0, |(done, count)| {
                        if *count == 0 {
                            1.0
                        } else {
                            *done as f64 / *count as f64
                        }
                    })
                })
                .sum();
            let progress = 5 + ((completed / device_ids.len() as f64) * 90.0).round() as u8;
            let label = evidence_device_label(device_id);
            let message = if processed == 0 {
                format!("{label}: preparing {total} unique alleles")
            } else {
                format!("{label}: {processed} of {total} unique alleles")
            };
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Running,
                progress,
                "evidence",
                message,
            )
            .map_err(dgw_core::DgwError::Tool)
        },
    );
    match outcome {
        Ok(result) if result.profile_input_fingerprint == expected_fingerprint => {
            let message = format!(
                "Profiled {} mutations with {} Evidence devices",
                result.active_mutations,
                result.device_coverage.len()
            );
            job.result = Some(serde_json::to_value(result).map_err(|error| error.to_string())?);
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Completed,
                100,
                "completed",
                message,
            )
        }
        Ok(_) => {
            let error =
                "the track profile no longer matches its captured inputs; run it again".to_owned();
            job.error = Some(error.clone());
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Failed,
                100,
                "failed",
                error,
            )
        }
        Err(error) => {
            let error = error.to_string();
            job.error = Some(error.clone());
            update_persistent_job(
                &project,
                &mut job,
                BackgroundJobStatus::Failed,
                100,
                "failed",
                error,
            )
        }
    }
}

impl From<BackgroundJob> for JobSummary {
    fn from(job: BackgroundJob) -> Self {
        Self {
            id: job.id,
            operation: job.operation,
            device_id: job.device_id,
            track_id: job.track_id,
            status: job.status,
            progress: job.progress,
            stage: job.stage,
            message: job.message,
            worker_threads: job.worker_threads,
            result_available: job.result.is_some(),
            error: job.error,
            created_at: job.created_at.to_rfc3339(),
            updated_at: job.updated_at.to_rfc3339(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_stable_tool_set() {
        let server = DgwMcpServer::new();
        let tools = server.tool_router.list_all();
        let mut names: Vec<_> = tools.iter().map(|tool| tool.name.as_ref()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "apply_allele_edit",
                "apply_genome_morph_preview",
                "apply_genome_optimizer_preview",
                "apply_mutation_generator_preview",
                "duplicate_track",
                "export_region_fasta",
                "get_job",
                "list_jobs",
                "list_tracks",
                "list_variant_contigs",
                "list_variants",
                "open_project",
                "preview_allele_edit",
                "project_summary",
                "rename_track",
                "search_genes",
                "select_track",
                "start_genome_morph_preview",
                "start_genome_optimizer_preview",
                "start_mutation_generator_preview",
                "start_track_profiler",
                "start_track_vcf_export",
            ]
        );
    }

    #[test]
    fn requires_an_active_or_explicit_project() {
        let server = DgwMcpServer::new();
        let error = server.resolve_project_path(None).unwrap_err();
        assert!(error.contains("Call open_project first"));
        assert_eq!(
            server
                .resolve_project_path(Some("/tmp/example.dgw".into()))
                .unwrap(),
            PathBuf::from("/tmp/example.dgw")
        );
    }

    #[tokio::test]
    async fn reports_invalid_project_as_a_tool_error() {
        let result = DgwMcpServer::new()
            .open_project(Parameters(OpenProjectRequest {
                project_path: "/tmp/does-not-exist.dgw".into(),
            }))
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true));
    }
}
