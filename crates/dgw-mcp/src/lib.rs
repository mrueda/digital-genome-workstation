use dgw_core::{
    AlleleEditPreview, BackgroundJob, BackgroundJobStatus, EditKind, EffectiveVariant,
    GeneSearchHit, GenomeState, GenomeTrack, Haplotype, Project, VariantContigSummary, VariantKey,
    VariantPage,
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
};

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

#[derive(Debug, Clone)]
pub struct DgwMcpServer {
    tool_router: ToolRouter<Self>,
    active_project: Arc<RwLock<Option<PathBuf>>>,
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
                "Call open_project with an existing .dgw directory first. Read operations are bounded; list_variants returns at most 200 variants per call. Positions are one-based. Manual allele changes require an editable track, an exact source allele, an explicit track-head precondition, and a fresh preview identifier."
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
                "duplicate_track",
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
