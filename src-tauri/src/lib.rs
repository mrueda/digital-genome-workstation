use dgw_core::evaluation::normalize_variant;
use dgw_core::{
    built_in_device_manifests, inspect_vcf, plan_optimizer_with_evidence, plan_randomizer,
    validate_resource_bundle, BackgroundJob, BackgroundJobStatus, CompoundMutationChange,
    CreateProjectRequest, DeviceManifest, EditKind, EditOperation, EffectiveVariant,
    EvaluationResult, EvaluationService, EvidenceResult, EvidenceStatus, FocusContext,
    FocusFastaExport, FocusView, GenomeState, GenomeTrack, Haplotype, OptimizerAlleleEvidenceInput,
    OptimizerDirection, OptimizerMode, OptimizerObjective, OptimizerPlan, OptimizerRequest,
    ProcessProgress, Project, ProjectSnapshot, RandomizerPlan, RandomizerRequest, ResourceBundle,
    SaturationAlleleInput, SelectionResolution, VariantContigSummary, VariantDensity,
    VariantNavigationBin, VariantPage, VariantSelection, VcfInspection, WorkspaceSnapshot,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager};
use uuid::Uuid;

struct AppState {
    evaluation: Arc<EvaluationService>,
    job_lock: Arc<Mutex<()>>,
    cancelled_jobs: Arc<Mutex<BTreeSet<String>>>,
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExampleFixture {
    path: PathBuf,
    sample: String,
    project_name: String,
    project_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedProject {
    project_path: PathBuf,
    snapshot: ProjectSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenomeTrackLane {
    track: GenomeTrack,
    edits: Vec<EditOperation>,
    variants: Vec<EffectiveVariant>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimizerRunResult {
    plan: OptimizerPlan,
    generated_edit_ids: Vec<String>,
    snapshot: ProjectSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RandomizerRunResult {
    plan: RandomizerPlan,
    generated_edit_ids: Vec<String>,
    snapshot: ProjectSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompoundLayerApplyResult {
    generated_edit_id: String,
    snapshot: ProjectSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackProfileDeviceCoverage {
    id: String,
    evaluated: u32,
    total: u32,
    exact_matches: u64,
    unavailable: u32,
    errors: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackEvidenceProfileResult {
    track_id: String,
    state_id: String,
    active_mutations: u32,
    evaluated_mutations: u32,
    impact_delta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    higher_impact_mutations: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lower_impact_mutations: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unchanged_impact_mutations: Option<u32>,
    device_coverage: Vec<TrackProfileDeviceCoverage>,
    limitation: String,
}

const RANDOMIZER_PREVIEW_CHANGE_LIMIT: usize = 200;
const RANDOMIZER_BULK_PREVIEW_THRESHOLD: usize = 1_000;
const RANDOMIZER_INTERACTIVE_MATERIALIZATION_LIMIT: u32 = 1_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RandomizerPreviewChange {
    contig: String,
    position: u64,
    from: String,
    to: String,
    substitution_class: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RandomizerPreviewResult {
    selected_positions: u32,
    randomized_positions: u32,
    transition_positions: u32,
    transversion_positions: u32,
    generated_edits: u32,
    excluded_positions: usize,
    change_count: usize,
    changes: Vec<RandomizerPreviewChange>,
    no_op_reason: Option<String>,
    limitation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    compound_layer_id: Option<String>,
}

fn substitution_class(reference: &str, alternate: &str) -> &'static str {
    match (reference.as_bytes(), alternate.as_bytes()) {
        ([b'A'], [b'G']) | ([b'G'], [b'A']) | ([b'C'], [b'T']) | ([b'T'], [b'C']) => "transition",
        _ => "transversion",
    }
}

fn compact_randomizer_preview(plan: &RandomizerPlan) -> RandomizerPreviewResult {
    let change_count = plan.randomized_positions as usize;
    let changes = if change_count > RANDOMIZER_BULK_PREVIEW_THRESHOLD {
        Vec::new()
    } else {
        let mut unique_changes = BTreeMap::new();
        for proposal in &plan.proposals {
            let source = &proposal.source_variant;
            let replacement = &proposal.replacement_variant;
            let key = format!(
                "{}:{}:{}:{}>{}",
                source.contig,
                source.position,
                source.reference,
                source.alternate,
                replacement.alternate
            );
            unique_changes
                .entry(key)
                .or_insert_with(|| RandomizerPreviewChange {
                    contig: source.contig.clone(),
                    position: source.position,
                    from: source.alternate.clone(),
                    to: replacement.alternate.clone(),
                    substitution_class: substitution_class(
                        &source.reference,
                        &replacement.alternate,
                    ),
                });
        }
        unique_changes
            .into_values()
            .take(RANDOMIZER_PREVIEW_CHANGE_LIMIT)
            .collect()
    };
    RandomizerPreviewResult {
        selected_positions: plan.selected_positions,
        randomized_positions: plan.randomized_positions,
        transition_positions: plan.transition_positions,
        transversion_positions: plan.transversion_positions,
        generated_edits: plan.generated_edits,
        excluded_positions: plan.exclusions.len(),
        change_count,
        changes,
        no_op_reason: plan.no_op_reason.clone(),
        limitation: plan.limitation.clone(),
        compound_layer_id: None,
    }
}

fn resolve_randomizer_request(
    project: &Project,
    track_id: &str,
    mut request: RandomizerRequest,
    selection: Option<VariantSelection>,
    selection_limit: Option<u32>,
) -> Result<(RandomizerRequest, Vec<EffectiveVariant>), String> {
    if let Some(selection) = selection {
        let limit = selection_limit
            .unwrap_or(dgw_core::MAX_RANDOMIZER_POSITIONS as u32)
            .min(dgw_core::MAX_RANDOMIZER_POSITIONS as u32)
            .max(1);
        let resolution = project
            .resolve_selection(&selection, limit)
            .map_err(error_text)?;
        if resolution.track_id != track_id {
            return Err("randomizer selection belongs to a different track".into());
        }
        if resolution.truncated {
            return Err(format!(
                "{} alleles are selected; Mutation Generator accepts at most {} positions per run",
                resolution.total, limit
            ));
        }
        request.selected_variants = resolution.variants;
    }
    let current = project
        .effective_variants_for_track_at_loci(track_id, &request.selected_variants)
        .map_err(error_text)?;
    Ok((request, current))
}

fn update_job(
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
    project.save_background_job(job).map_err(error_text)
}

fn job_was_cancelled(cancelled_jobs: &Mutex<BTreeSet<String>>, job_id: &str) -> bool {
    cancelled_jobs
        .lock()
        .map(|jobs| jobs.contains(job_id))
        .unwrap_or(true)
}

fn available_project_path(parent: PathBuf, stem: &str) -> PathBuf {
    let initial = parent.join(format!("{stem}.dgw"));
    if !initial.exists() {
        return initial;
    }

    for suffix in 2.. {
        let candidate = parent.join(format!("{stem}-{suffix}.dgw"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

#[tauri::command]
fn example_fixture(app: tauri::AppHandle) -> Result<ExampleFixture, String> {
    let development_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/dgw-cluster.synthetic.vcf");
    let path = if development_path.is_file() {
        development_path
    } else {
        app.path()
            .resolve(
                "fixtures/dgw-cluster.synthetic.vcf",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(error_text)?
    };
    if !path.is_file() {
        return Err(format!(
            "Bundled example VCF was not found: {}",
            path.display()
        ));
    }

    let projects_dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(error_text)?
        .join("DGW Projects");

    Ok(ExampleFixture {
        path,
        sample: "DGW_DEMO".into(),
        project_name: "DGW clustered variants example".into(),
        project_path: available_project_path(projects_dir, "dgw-cluster-example"),
    })
}

#[tauri::command]
fn inspect_vcf_file(
    path: PathBuf,
    assembly: Option<String>,
    on_progress: Channel<ProcessProgress>,
) -> Result<VcfInspection, String> {
    let _ = on_progress.send(ProcessProgress::new(
        "vcfInspection",
        "open",
        "Opening the VCF",
        1,
        3,
    ));
    let _ = on_progress.send(ProcessProgress::new(
        "vcfInspection",
        "scan",
        "Reading headers, samples, filters, and variant records",
        2,
        3,
    ));
    let inspection = inspect_vcf(path, assembly.as_deref().unwrap_or("b37")).map_err(error_text)?;
    let _ = on_progress.send(ProcessProgress::new(
        "vcfInspection",
        "summary",
        "VCF inspection complete",
        3,
        3,
    ));
    Ok(inspection)
}

#[tauri::command]
fn validate_bundle(bundle: ResourceBundle) -> Result<Vec<String>, String> {
    validate_resource_bundle(&bundle).map_err(error_text)
}

#[tauri::command]
fn device_catalog() -> Vec<DeviceManifest> {
    built_in_device_manifests()
}

#[tauri::command]
fn create_project(
    request: CreateProjectRequest,
    on_progress: Channel<ProcessProgress>,
) -> Result<ProjectSnapshot, String> {
    let project = Project::create_with_progress(request, |progress| {
        let _ = on_progress.send(progress);
    })
    .map_err(error_text)?;
    let _ = on_progress.send(ProcessProgress::new(
        "vcfImport",
        "workspace",
        "Opening the completed genome workspace",
        10,
        10,
    ));
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn create_project_from_current(
    current_project_path: PathBuf,
    template_id: String,
) -> Result<CreatedProject, String> {
    let (suffix, template_label) = match template_id.as_str() {
        "standardEvidence" => ("dgw-starter", "DGW Starter"),
        "empty" => ("empty", "Empty"),
        _ => return Err(format!("unknown project template: {template_id}")),
    };
    let current = Project::open(&current_project_path).map_err(error_text)?;
    let manifest = current.manifest().clone();
    let source_vcf_path = if manifest.source_vcf.path.is_file() {
        manifest.source_vcf.path.clone()
    } else {
        current.root().join(&manifest.selected_vcf_path)
    };
    if !source_vcf_path.is_file() {
        return Err(format!(
            "Neither the original VCF nor the frozen selected-sample VCF is available for {}",
            manifest.name
        ));
    }
    let parent = current
        .root()
        .parent()
        .ok_or_else(|| "the current project has no parent directory".to_string())?;
    let current_stem = current
        .root()
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("genome-project");
    let project_path =
        available_project_path(parent.to_path_buf(), &format!("{current_stem}-{suffix}"));
    let project = Project::create(CreateProjectRequest {
        project_path: project_path.clone(),
        name: format!("{} — {}", manifest.name, template_label),
        source_vcf_path,
        selected_sample: manifest.selected_sample,
        resource_bundle: manifest.resource_bundle,
    })
    .map_err(error_text)?;
    let snapshot = project.snapshot().map_err(error_text)?;
    Ok(CreatedProject {
        project_path,
        snapshot,
    })
}

#[tauri::command]
fn open_project(path: PathBuf) -> Result<ProjectSnapshot, String> {
    Project::open(path)
        .and_then(|project| project.snapshot())
        .map_err(error_text)
}

#[tauri::command]
fn focus_region(project_path: PathBuf, context: FocusContext) -> Result<FocusView, String> {
    Project::open(project_path)
        .and_then(|project| project.focus_view(context))
        .map_err(error_text)
}

#[tauri::command]
fn export_focus_fasta(
    project_path: PathBuf,
    track_id: String,
    context: FocusContext,
    output_path: PathBuf,
) -> Result<FocusFastaExport, String> {
    Project::open(project_path)
        .and_then(|project| project.export_focus_fasta(&track_id, context, output_path))
        .map_err(error_text)
}

#[tauri::command]
fn track_deck(
    project_path: PathBuf,
    context: Option<FocusContext>,
) -> Result<Vec<GenomeTrackLane>, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let workspace = project.workspace().map_err(error_text)?;
    let context = context.or(workspace.focus);
    project
        .list_tracks()
        .map_err(error_text)?
        .into_iter()
        .map(|track| {
            let edits = project.edits_for_track(&track.id).map_err(error_text)?;
            let mut variants = match &context {
                Some(context) => project
                    .effective_variants_for_track_in_context(&track.id, context)
                    .map_err(error_text)?,
                None => {
                    project
                        .variant_page(&track.id, 0, dgw_core::VARIANT_PAGE_SIZE)
                        .map_err(error_text)?
                        .variants
                }
            };
            variants.truncate(dgw_core::MAX_TRACK_REGION_VARIANTS);
            Ok(GenomeTrackLane {
                track,
                edits,
                variants,
            })
        })
        .collect()
}

#[tauri::command]
fn variant_page(
    project_path: PathBuf,
    track_id: String,
    offset: u64,
    limit: Option<u32>,
) -> Result<VariantPage, String> {
    Project::open(project_path)
        .and_then(|project| {
            project.variant_page(
                &track_id,
                offset,
                limit.unwrap_or(dgw_core::VARIANT_PAGE_SIZE),
            )
        })
        .map_err(error_text)
}

#[tauri::command]
fn variant_density(
    project_path: PathBuf,
    track_id: String,
    context: FocusContext,
) -> Result<VariantDensity, String> {
    Project::open(project_path)
        .and_then(|project| project.variant_density(&track_id, context))
        .map_err(error_text)
}

#[tauri::command]
fn variant_contigs(project_path: PathBuf) -> Result<Vec<VariantContigSummary>, String> {
    Project::open(project_path)
        .and_then(|project| project.variant_contig_summaries())
        .map_err(error_text)
}

#[tauri::command]
fn variant_navigation_bins(
    project_path: PathBuf,
    contig: String,
    bins: u32,
    start: Option<u64>,
    end: Option<u64>,
) -> Result<Vec<VariantNavigationBin>, String> {
    Project::open(project_path)
        .and_then(|project| project.variant_navigation_bins_in_region(&contig, start, end, bins))
        .map_err(error_text)
}

#[tauri::command]
fn resolve_variant_selection(
    project_path: PathBuf,
    selection: VariantSelection,
    limit: u32,
) -> Result<SelectionResolution, String> {
    Project::open(project_path)
        .and_then(|project| project.resolve_selection(&selection, limit))
        .map_err(error_text)
}

#[tauri::command]
fn save_workspace(
    project_path: PathBuf,
    workspace: WorkspaceSnapshot,
) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project.save_workspace(&workspace).map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn select_track(project_path: PathBuf, track_id: String) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project.select_track(&track_id).map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn duplicate_track(
    project_path: PathBuf,
    track_id: String,
    name: String,
) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let track = project
        .duplicate_track(&track_id, name)
        .map_err(error_text)?;
    project.select_track(&track.id).map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn rename_track(
    project_path: PathBuf,
    track_id: String,
    name: String,
) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project.rename_track(&track_id, name).map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn delete_track(project_path: PathBuf, track_id: String) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project.delete_track(&track_id).map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn consolidate_track(project_path: PathBuf, track_id: String) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project.consolidate_track(&track_id).map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn run_optimizer(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    track_id: String,
    focus: FocusContext,
    request: OptimizerRequest,
) -> Result<OptimizerRunResult, String> {
    if request.selected_variants.is_empty() {
        return Err("Select at least one active allele before running Genome Optimizer.".into());
    }
    let project = Project::open(project_path).map_err(error_text)?;
    let current = project
        .effective_variants_for_track_at_loci(&track_id, &request.selected_variants)
        .map_err(error_text)?;
    let plan = match request.mode {
        OptimizerMode::Conservative => {
            let source = project
                .source_variants_at_loci(&request.selected_variants)
                .map_err(error_text)?;
            let evaluated = evaluate_conservative_alleles(
                &state.evaluation,
                &project,
                &current,
                &source,
                &request,
            )?;
            plan_optimizer_with_evidence(&current, &source, &focus, &request, &evaluated)
                .map_err(error_text)?
        }
        OptimizerMode::Saturation => {
            let evaluated = evaluate_saturation_candidates(&state.evaluation, &project, &request)?;
            dgw_core::plan_saturation_optimizer(&current, &focus, &request, &evaluated)
                .map_err(error_text)?
        }
    };
    let note = format!(
        "Genome Optimizer · {:?} · {:?} {:?} · additive per-allele score",
        request.mode, request.direction, request.objective
    );
    let batch: Vec<_> = plan
        .proposals
        .iter()
        .map(|proposal| {
            (
                proposal.haplotype,
                proposal.edit.clone(),
                Some(note.clone()),
            )
        })
        .collect();
    let generated_edit_ids = project
        .apply_edits_to_track(&track_id, &batch)
        .map_err(error_text)?
        .into_iter()
        .filter_map(|state| state.edit_id)
        .collect();
    let snapshot = project.snapshot().map_err(error_text)?;
    Ok(OptimizerRunResult {
        plan,
        generated_edit_ids,
        snapshot,
    })
}

fn evaluate_conservative_alleles(
    evaluation: &EvaluationService,
    project: &Project,
    current: &[EffectiveVariant],
    source: &[EffectiveVariant],
    request: &OptimizerRequest,
) -> Result<Vec<OptimizerAlleleEvidenceInput>, String> {
    const SNPEFF: &str = "org.dgw.builtin.snpeff";
    const CLINVAR: &str = "org.dgw.builtin.clinvar";
    let need_snpeff = request.objective == OptimizerObjective::PredictedImpactBurden
        && request.weights.impact > 0.0;
    let need_clinvar_guard = request.direction == OptimizerDirection::Maximize;
    if need_snpeff
        && !request
            .evidence_device_ids
            .iter()
            .any(|device_id| device_id == SNPEFF)
    {
        return Err("Weighted annotation burden requires an applied, active SnpEff device.".into());
    }
    if need_clinvar_guard
        && !request
            .evidence_device_ids
            .iter()
            .any(|device_id| device_id == CLINVAR)
    {
        return Err(
            "This optimizer direction requires an applied, active ClinVar device for the fixed Pathogenic/Likely pathogenic guard."
                .into(),
        );
    }

    let source_keys: std::collections::BTreeSet<_> = source
        .iter()
        .map(|variant| variant.key.stable_key())
        .collect();
    let mut keys = BTreeMap::new();
    for variant in current.iter().chain(source.iter()) {
        keys.entry(variant.key.stable_key())
            .or_insert_with(|| variant.key.clone());
    }
    let mut evaluated = Vec::with_capacity(keys.len());
    for key in keys.into_values() {
        let snpeff = if need_snpeff {
            evaluation
                .evaluate_device(project, &key, SNPEFF)
                .map_err(error_text)?
        } else {
            not_computed_evidence("SnpEff")
        };
        let clinvar = if need_clinvar_guard && source_keys.contains(&key.stable_key()) {
            evaluation
                .evaluate_device(project, &key, CLINVAR)
                .map_err(error_text)?
        } else {
            not_computed_evidence("ClinVar")
        };
        evaluated.push(OptimizerAlleleEvidenceInput {
            variant: key,
            snpeff,
            clinvar,
        });
    }
    Ok(evaluated)
}

fn not_computed_evidence(source: &str) -> EvidenceResult {
    EvidenceResult {
        source: source.into(),
        status: EvidenceStatus::NotComputed,
        records: Vec::new(),
        message: None,
    }
}

fn evaluate_saturation_candidates(
    evaluation: &EvaluationService,
    project: &Project,
    request: &OptimizerRequest,
) -> Result<Vec<SaturationAlleleInput>, String> {
    const SNPEFF: &str = "org.dgw.builtin.snpeff";
    const CLINVAR: &str = "org.dgw.builtin.clinvar";
    if !request
        .evidence_device_ids
        .iter()
        .any(|device_id| device_id == SNPEFF)
    {
        return Err("Saturation mode requires an applied, active SnpEff device for comparable candidate scoring.".into());
    }
    if !request
        .evidence_device_ids
        .iter()
        .any(|device_id| device_id == CLINVAR)
    {
        return Err("Saturation mode requires an applied, active ClinVar device for the fixed Pathogenic/Likely pathogenic guard.".into());
    }

    let mut evaluated = Vec::new();
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
            let candidate = dgw_core::VariantKey {
                assembly: selected.assembly.clone(),
                contig: selected.contig.clone(),
                position: selected.position,
                reference: char::from(reference).to_string(),
                alternate: char::from(alternate).to_string(),
            };
            let results: BTreeMap<String, EvidenceResult> = BTreeMap::from([
                (
                    SNPEFF.into(),
                    evaluation
                        .evaluate_device(project, &candidate, SNPEFF)
                        .map_err(error_text)?,
                ),
                (
                    CLINVAR.into(),
                    evaluation
                        .evaluate_device(project, &candidate, CLINVAR)
                        .map_err(error_text)?,
                ),
            ]);
            if let Some(snpeff) = results.get(SNPEFF) {
                if matches!(
                    snpeff.status,
                    EvidenceStatus::Error | EvidenceStatus::ResourceUnavailable
                ) {
                    return Err(format!(
                        "SnpEff could not evaluate saturation candidate {}: {}",
                        candidate.display(),
                        snpeff
                            .message
                            .as_deref()
                            .unwrap_or("resource or annotation failure")
                    ));
                }
            }
            let evidence_statuses = results
                .iter()
                .map(|(device_id, result)| {
                    (
                        device_id.clone(),
                        evidence_status_label(&result.status).into(),
                    )
                })
                .collect();
            let exact_evidence_sources = results
                .iter()
                .filter(|(device_id, result)| {
                    device_id.as_str() != SNPEFF && result.status == EvidenceStatus::Found
                })
                .map(|(_, result)| result.source.clone())
                .collect();
            evaluated.push(SaturationAlleleInput {
                source_variant: selected.clone(),
                candidate_variant: candidate,
                snpeff: results
                    .get(SNPEFF)
                    .cloned()
                    .unwrap_or_else(|| not_computed_evidence("SnpEff")),
                clinvar: results
                    .get(CLINVAR)
                    .cloned()
                    .unwrap_or_else(|| not_computed_evidence("ClinVar")),
                evidence_statuses,
                exact_evidence_sources,
            });
        }
    }
    Ok(evaluated)
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

#[tauri::command]
async fn preview_randomizer(
    project_path: PathBuf,
    track_id: String,
    request: RandomizerRequest,
    selection: Option<VariantSelection>,
    selection_limit: Option<u32>,
) -> Result<RandomizerPreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = Project::open(project_path).map_err(error_text)?;
        let (request, current) =
            resolve_randomizer_request(&project, &track_id, request, selection, selection_limit)?;
        plan_randomizer(&current, &request)
            .map(|plan| compact_randomizer_preview(&plan))
            .map_err(error_text)
    })
    .await
    .map_err(|error| format!("bulk preview worker failed: {error}"))?
}

#[tauri::command]
fn start_randomizer_preview_job(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    track_id: String,
    request: RandomizerRequest,
    selection: Option<VariantSelection>,
    selection_limit: Option<u32>,
    worker_threads: Option<u16>,
) -> Result<BackgroundJob, String> {
    let project = Project::open(&project_path).map_err(error_text)?;
    let now = chrono::Utc::now();
    let request_payload = serde_json::json!({
        "request": &request,
        "selection": &selection,
        "selectionLimit": selection_limit,
    });
    let mut job = BackgroundJob {
        id: Uuid::new_v4().to_string(),
        operation: "mutationGeneratorPreview".into(),
        device_id: "org.dgw.builtin.mutation-generator".into(),
        track_id: track_id.clone(),
        status: BackgroundJobStatus::Queued,
        progress: 0,
        stage: "queued".into(),
        message: "Waiting for the background compute slot".into(),
        worker_threads: worker_threads.unwrap_or(1).clamp(1, 256),
        request: request_payload,
        result: None,
        error: None,
        created_at: now,
        updated_at: now,
    };
    project.save_background_job(&job).map_err(error_text)?;

    let returned_job = job.clone();
    let job_lock = Arc::clone(&state.job_lock);
    let cancelled_jobs = Arc::clone(&state.cancelled_jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let lock = match job_lock.lock() {
            Ok(lock) => lock,
            Err(error) => {
                job.error = Some(format!("background compute lock failed: {error}"));
                let message = job.error.clone().unwrap_or_default();
                let _ = update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Failed,
                    100,
                    "failed",
                    message,
                );
                return;
            }
        };
        let _lock = lock;
        if job_was_cancelled(&cancelled_jobs, &job.id) {
            let _ = update_job(
                &project,
                &mut job,
                BackgroundJobStatus::Cancelled,
                100,
                "cancelled",
                "Job cancelled before execution",
            );
            return;
        }
        if let Err(error) = update_job(
            &project,
            &mut job,
            BackgroundJobStatus::Running,
            10,
            "selection",
            "Resolving the selected variants",
        ) {
            job.error = Some(error);
            return;
        }

        let outcome = (|| -> Result<RandomizerPreviewResult, String> {
            let source_state_id = project.track(&track_id).map_err(error_text)?.head_state_id;
            let (request, current) = resolve_randomizer_request(
                &project,
                &track_id,
                request,
                selection,
                selection_limit,
            )?;
            if job_was_cancelled(&cancelled_jobs, &job.id) {
                return Err("__cancelled__".into());
            }
            update_job(
                &project,
                &mut job,
                BackgroundJobStatus::Running,
                70,
                "planning",
                format!("Planning changes across {} active variants", current.len()),
            )?;
            let plan = plan_randomizer(&current, &request).map_err(error_text)?;
            let mut preview = compact_randomizer_preview(&plan);
            if !plan.proposals.is_empty() {
                update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Running,
                    85,
                    "staging",
                    format!(
                        "Storing {} changes as one reversible mutation layer",
                        plan.generated_edits
                    ),
                )?;
                let note = format!(
                    "Mutation Generator · Randomizer · {} · seed {} · amount {}% · {} positions",
                    request.substitution_pattern.label(),
                    request.seed,
                    request.amount,
                    plan.randomized_positions
                );
                let changes: Vec<_> = plan
                    .proposals
                    .iter()
                    .map(|proposal| CompoundMutationChange {
                        haplotype: proposal.haplotype,
                        edit: proposal.edit.clone(),
                    })
                    .collect();
                let layer = project
                    .stage_compound_mutation_layer(
                        &track_id,
                        &source_state_id,
                        "org.dgw.builtin.mutation-generator",
                        plan.randomized_positions,
                        &changes,
                        Some(note),
                    )
                    .map_err(error_text)?;
                preview.compound_layer_id = Some(layer.id);
            }
            Ok(preview)
        })();

        match outcome {
            Ok(result) => {
                job.result = serde_json::to_value(result).ok();
                let _ = update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Completed,
                    100,
                    "completed",
                    "Bulk preview completed",
                );
            }
            Err(error) if error == "__cancelled__" => {
                let _ = update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Cancelled,
                    100,
                    "cancelled",
                    "Job cancelled",
                );
            }
            Err(error) => {
                job.error = Some(error.clone());
                let _ = update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Failed,
                    100,
                    "failed",
                    error,
                );
            }
        }
    });
    Ok(returned_job)
}

#[tauri::command]
fn background_job(project_path: PathBuf, job_id: String) -> Result<BackgroundJob, String> {
    Project::open(project_path)
        .and_then(|project| project.background_job(&job_id))
        .map_err(error_text)
}

#[tauri::command]
fn list_background_jobs(
    project_path: PathBuf,
    limit: Option<u32>,
) -> Result<Vec<BackgroundJob>, String> {
    Project::open(project_path)
        .and_then(|project| project.list_background_jobs(limit.unwrap_or(50)))
        .map_err(error_text)
}

#[tauri::command]
fn cancel_background_job(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    job_id: String,
) -> Result<BackgroundJob, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let mut job = project.background_job(&job_id).map_err(error_text)?;
    if matches!(
        job.status,
        BackgroundJobStatus::Completed
            | BackgroundJobStatus::Failed
            | BackgroundJobStatus::Cancelled
    ) {
        return Ok(job);
    }
    state
        .cancelled_jobs
        .lock()
        .map_err(|error| format!("background cancellation lock failed: {error}"))?
        .insert(job_id);
    update_job(
        &project,
        &mut job,
        BackgroundJobStatus::Cancelled,
        100,
        "cancelled",
        "Cancellation requested",
    )?;
    Ok(job)
}

#[tauri::command]
fn start_track_evidence_profile_job(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    track_id: String,
    device_ids: Vec<String>,
    worker_threads: Option<u16>,
) -> Result<BackgroundJob, String> {
    const SUPPORTED: [&str; 4] = [
        "org.dgw.builtin.snpeff",
        "org.dgw.builtin.dbnsfp",
        "org.dgw.builtin.clinvar",
        "org.dgw.builtin.cosmic",
    ];
    let mut device_ids: Vec<String> = device_ids
        .into_iter()
        .filter(|device_id| SUPPORTED.contains(&device_id.as_str()))
        .collect();
    let mut seen_devices = BTreeSet::new();
    device_ids.retain(|device_id| seen_devices.insert(device_id.clone()));
    if device_ids.is_empty() {
        return Err("Track Profiler requires at least one active Evidence device".into());
    }

    let project = Project::open(&project_path).map_err(error_text)?;
    let captured_track = project.track(&track_id).map_err(error_text)?;
    let now = chrono::Utc::now();
    let mut job = BackgroundJob {
        id: Uuid::new_v4().to_string(),
        operation: "trackEvidenceProfile".into(),
        device_id: "org.dgw.builtin.track-profiler".into(),
        track_id: track_id.clone(),
        status: BackgroundJobStatus::Queued,
        progress: 0,
        stage: "queued".into(),
        message: "Waiting for the background compute slot".into(),
        worker_threads: worker_threads.unwrap_or(1).clamp(1, 256),
        request: serde_json::json!({
            "stateId": &captured_track.head_state_id,
            "bypassedEditIds": &captured_track.bypassed_edit_ids,
            "deviceIds": &device_ids,
        }),
        result: None,
        error: None,
        created_at: now,
        updated_at: now,
    };
    project.save_background_job(&job).map_err(error_text)?;

    let returned_job = job.clone();
    let evaluation = Arc::clone(&state.evaluation);
    let job_lock = Arc::clone(&state.job_lock);
    let cancelled_jobs = Arc::clone(&state.cancelled_jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let lock = match job_lock.lock() {
            Ok(lock) => lock,
            Err(error) => {
                job.error = Some(format!("background compute lock failed: {error}"));
                let message = job.error.clone().unwrap_or_default();
                let _ = update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Failed,
                    100,
                    "failed",
                    message,
                );
                return;
            }
        };
        let _lock = lock;
        if job_was_cancelled(&cancelled_jobs, &job.id) {
            let _ = update_job(
                &project,
                &mut job,
                BackgroundJobStatus::Cancelled,
                100,
                "cancelled",
                "Job cancelled before execution",
            );
            return;
        }
        if let Err(error) = update_job(
            &project,
            &mut job,
            BackgroundJobStatus::Running,
            5,
            "mutations",
            "Expanding active track mutations",
        ) {
            job.error = Some(error);
            return;
        }

        let outcome = (|| -> Result<TrackEvidenceProfileResult, String> {
            let mutations = project
                .active_track_mutations(&track_id)
                .map_err(error_text)?;
            if mutations.is_empty() {
                return Err("the selected track has no active mutations to profile".into());
            }
            let active_mutations = u32::try_from(mutations.len()).unwrap_or(u32::MAX);
            let mut unique = BTreeSet::new();
            for mutation in &mutations {
                unique.insert(mutation.source_variant.clone());
                if let Some(current) = &mutation.current_variant {
                    unique.insert(current.clone());
                }
            }
            let variants: Vec<_> = unique.into_iter().collect();
            let device_total = device_ids.len();
            let mut device_coverage = Vec::with_capacity(device_total);
            let mut evaluated_mutations = 0_u32;
            let mut impact_delta = None;
            let mut higher_impact_mutations = None;
            let mut lower_impact_mutations = None;
            let mut unchanged_impact_mutations = None;

            for (device_index, device_id) in device_ids.iter().enumerate() {
                if job_was_cancelled(&cancelled_jobs, &job.id) {
                    return Err("__cancelled__".into());
                }
                let label = evidence_device_label(device_id);
                let starting_progress =
                    5 + (((device_index as f64) / device_total as f64) * 90.0).round() as u8;
                update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Running,
                    starting_progress,
                    "evidence",
                    format!("{label}: preparing {} unique alleles", variants.len()),
                )?;
                let mut last_reported = 0_usize;
                let signals = evaluation
                    .evaluate_device_signals(&project, &variants, device_id, |processed, total| {
                        if job_was_cancelled(&cancelled_jobs, &job.id) {
                            return Err(dgw_core::DgwError::Tool("__cancelled__".into()));
                        }
                        if processed == total || processed.saturating_sub(last_reported) >= 250 {
                            last_reported = processed;
                            let completed = device_index as f64
                                + if total == 0 {
                                    1.0
                                } else {
                                    processed as f64 / total as f64
                                };
                            let progress =
                                5 + ((completed / device_total as f64) * 90.0).round() as u8;
                            update_job(
                                &project,
                                &mut job,
                                BackgroundJobStatus::Running,
                                progress,
                                "evidence",
                                format!("{label}: {} of {} unique alleles", processed, total),
                            )
                            .map_err(dgw_core::DgwError::Project)?;
                        }
                        Ok(())
                    })
                    .map_err(|error| {
                        if error.to_string().contains("__cancelled__") {
                            "__cancelled__".into()
                        } else {
                            error_text(error)
                        }
                    })?;

                let mut evaluated = 0_u32;
                let mut exact_matches = 0_u64;
                let mut unavailable = 0_u32;
                let mut errors = 0_u32;
                let mut device_impact_delta = 0.0_f64;
                let mut impact_complete = true;
                let mut device_higher = 0_u32;
                let mut device_lower = 0_u32;
                let mut device_unchanged = 0_u32;
                for mutation in &mutations {
                    let source = signals.get(&mutation.source_variant);
                    let current = mutation
                        .current_variant
                        .as_ref()
                        .and_then(|variant| signals.get(variant));
                    let terminal = |signal: Option<&dgw_core::evaluation::BatchEvidenceSignal>| {
                        signal.is_some_and(|signal| {
                            matches!(
                                signal.status,
                                EvidenceStatus::Found | EvidenceStatus::NoExactMatch
                            )
                        })
                    };
                    if terminal(source) && (mutation.current_variant.is_none() || terminal(current))
                    {
                        evaluated = evaluated.saturating_add(1);
                    }
                    if let Some(current) = current {
                        exact_matches =
                            exact_matches.saturating_add(u64::from(current.exact_match_count));
                    }
                    let statuses = [source, current]
                        .into_iter()
                        .flatten()
                        .map(|signal| &signal.status);
                    let mut mutation_unavailable = false;
                    let mut mutation_error = false;
                    for status in statuses {
                        mutation_unavailable |= *status == EvidenceStatus::ResourceUnavailable;
                        mutation_error |= *status == EvidenceStatus::Error;
                    }
                    unavailable = unavailable.saturating_add(u32::from(mutation_unavailable));
                    errors = errors.saturating_add(u32::from(mutation_error));

                    if device_id == "org.dgw.builtin.snpeff" {
                        let source_impact = source.and_then(|signal| signal.impact_signal);
                        let current_impact = if mutation.current_variant.is_none() {
                            Some(0.0)
                        } else {
                            current.and_then(|signal| signal.impact_signal)
                        };
                        match (source_impact, current_impact) {
                            (Some(source), Some(current)) => {
                                let delta = current - source;
                                device_impact_delta += delta;
                                if delta > f64::EPSILON {
                                    device_higher = device_higher.saturating_add(1);
                                } else if delta < -f64::EPSILON {
                                    device_lower = device_lower.saturating_add(1);
                                } else {
                                    device_unchanged = device_unchanged.saturating_add(1);
                                }
                            }
                            _ => impact_complete = false,
                        }
                    }
                }
                if device_id == "org.dgw.builtin.snpeff" {
                    evaluated_mutations = if impact_complete {
                        active_mutations
                    } else {
                        mutations
                            .iter()
                            .filter(|mutation| {
                                let source = signals
                                    .get(&mutation.source_variant)
                                    .and_then(|signal| signal.impact_signal);
                                let current = if mutation.current_variant.is_none() {
                                    Some(0.0)
                                } else {
                                    mutation
                                        .current_variant
                                        .as_ref()
                                        .and_then(|variant| signals.get(variant))
                                        .and_then(|signal| signal.impact_signal)
                                };
                                source.is_some() && current.is_some()
                            })
                            .count() as u32
                    };
                    if impact_complete {
                        impact_delta = Some(device_impact_delta);
                    }
                    higher_impact_mutations = Some(device_higher);
                    lower_impact_mutations = Some(device_lower);
                    unchanged_impact_mutations = Some(device_unchanged);
                }
                device_coverage.push(TrackProfileDeviceCoverage {
                    id: device_id.clone(),
                    evaluated,
                    total: active_mutations,
                    exact_matches,
                    unavailable,
                    errors,
                });
            }

            let current_track = project.track(&track_id).map_err(error_text)?;
            if current_track.head_state_id != captured_track.head_state_id
                || current_track.bypassed_edit_ids != captured_track.bypassed_edit_ids
            {
                return Err(
                    "the track changed while Evidence profiling was running; run it again".into(),
                );
            }
            Ok(TrackEvidenceProfileResult {
                track_id: track_id.clone(),
                state_id: captured_track.head_state_id.clone(),
                active_mutations,
                evaluated_mutations,
                impact_delta,
                higher_impact_mutations,
                lower_impact_mutations,
                unchanged_impact_mutations,
                device_coverage,
                limitation: "Additive exact-allele evidence. Nearby interactions, phase-dependent combined consequences, penetrance, and disease probability are not modeled.".into(),
            })
        })();

        match outcome {
            Ok(result) => {
                job.result = serde_json::to_value(&result).ok();
                let message = format!(
                    "Profiled {} mutations with {} Evidence devices",
                    result.active_mutations,
                    result.device_coverage.len()
                );
                let _ = update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Completed,
                    100,
                    "completed",
                    message,
                );
            }
            Err(error) if error == "__cancelled__" => {
                let _ = update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Cancelled,
                    100,
                    "cancelled",
                    "Track profiling cancelled",
                );
            }
            Err(error) => {
                job.error = Some(error.clone());
                let _ = update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Failed,
                    100,
                    "failed",
                    error,
                );
            }
        }
    });
    Ok(returned_job)
}

fn evidence_device_label(device_id: &str) -> &'static str {
    match device_id {
        "org.dgw.builtin.snpeff" => "SnpEff",
        "org.dgw.builtin.dbnsfp" => "dbNSFP",
        "org.dgw.builtin.clinvar" => "ClinVar",
        "org.dgw.builtin.cosmic" => "COSMIC",
        _ => "Evidence",
    }
}

#[tauri::command]
fn run_randomizer(
    project_path: PathBuf,
    track_id: String,
    request: RandomizerRequest,
    selection: Option<VariantSelection>,
    selection_limit: Option<u32>,
) -> Result<RandomizerRunResult, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let (request, current) =
        resolve_randomizer_request(&project, &track_id, request, selection, selection_limit)?;
    let plan = plan_randomizer(&current, &request).map_err(error_text)?;
    if plan.randomized_positions > RANDOMIZER_INTERACTIVE_MATERIALIZATION_LIMIT {
        return Err(format!(
            "bulk preview contains {} changed positions; materializing visible mutation blocks is currently limited to {} positions",
            plan.randomized_positions, RANDOMIZER_INTERACTIVE_MATERIALIZATION_LIMIT
        ));
    }
    let note = format!(
        "Mutation Generator · Randomizer · {} · seed {} · amount {}%",
        request.substitution_pattern.label(),
        request.seed,
        request.amount
    );
    let batch: Vec<_> = plan
        .proposals
        .iter()
        .map(|proposal| {
            (
                proposal.haplotype,
                proposal.edit.clone(),
                Some(note.clone()),
            )
        })
        .collect();
    let generated_edit_ids = project
        .apply_edits_to_track(&track_id, &batch)
        .map_err(error_text)?
        .into_iter()
        .filter_map(|state| state.edit_id)
        .collect();
    let snapshot = project.snapshot().map_err(error_text)?;
    Ok(RandomizerRunResult {
        plan,
        generated_edit_ids,
        snapshot,
    })
}

#[tauri::command]
fn apply_compound_mutation_layer(
    project_path: PathBuf,
    track_id: String,
    layer_id: String,
) -> Result<CompoundLayerApplyResult, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let state = project
        .apply_compound_mutation_layer(&track_id, &layer_id)
        .map_err(error_text)?;
    let generated_edit_id = state
        .edit_id
        .ok_or_else(|| "compound mutation state has no edit id".to_string())?;
    Ok(CompoundLayerApplyResult {
        generated_edit_id,
        snapshot: project.snapshot().map_err(error_text)?,
    })
}

#[tauri::command]
fn set_track_edit_bypass(
    project_path: PathBuf,
    track_id: String,
    edit_id: String,
    bypassed: bool,
) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project
        .toggle_track_edit_bypass(&track_id, &edit_id, bypassed)
        .map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn set_track_edits_bypass(
    project_path: PathBuf,
    track_id: String,
    edit_ids: Vec<String>,
    bypassed: bool,
) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project
        .toggle_track_edits_bypass(&track_id, &edit_ids, bypassed)
        .map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
fn apply_edit(
    project_path: PathBuf,
    track_id: Option<String>,
    parent_state_id: String,
    haplotype: Haplotype,
    mut edit: EditKind,
    note: Option<String>,
    bypassed_edit_ids: Vec<String>,
) -> Result<GenomeState, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    if let EditKind::SetAllele { key, source_key } = &edit {
        let normalized =
            normalize_variant(&project.manifest().resource_bundle, key).map_err(error_text)?;
        edit = EditKind::SetAllele {
            key: normalized,
            source_key: source_key.clone(),
        };
    }
    match track_id {
        Some(track_id) => project
            .apply_edit_to_track(&track_id, haplotype, edit, note)
            .map_err(error_text),
        None => project
            .apply_edit(&parent_state_id, haplotype, edit, note, &bypassed_edit_ids)
            .map_err(error_text),
    }
}

#[tauri::command]
async fn evaluate_variant(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    variant: dgw_core::VariantKey,
) -> Result<EvaluationResult, String> {
    let evaluation = state.evaluation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let project = Project::open(project_path).map_err(error_text)?;
        evaluation.evaluate(&project, &variant).map_err(error_text)
    })
    .await
    .map_err(error_text)?
}

#[tauri::command]
async fn evaluate_device(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    variant: dgw_core::VariantKey,
    device_id: String,
) -> Result<EvidenceResult, String> {
    let evaluation = state.evaluation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let project = Project::open(project_path).map_err(error_text)?;
        evaluation
            .evaluate_device(&project, &variant, &device_id)
            .map_err(error_text)
    })
    .await
    .map_err(error_text)?
}

#[tauri::command]
fn render_state(
    project_path: PathBuf,
    state_id: String,
    bypassed_edit_ids: Vec<String>,
    output_path: PathBuf,
) -> Result<PathBuf, String> {
    Project::open(project_path)
        .and_then(|project| project.render_state(&state_id, &bypassed_edit_ids, output_path))
        .map_err(error_text)
}

#[tauri::command]
fn render_track(
    project_path: PathBuf,
    track_id: String,
    output_path: PathBuf,
) -> Result<PathBuf, String> {
    Project::open(project_path)
        .and_then(|project| project.render_track(&track_id, output_path))
        .map_err(error_text)
}

#[tauri::command]
fn suggested_development_bundle() -> ResourceBundle {
    use dgw_core::IndexedResource;
    ResourceBundle {
        schema_version: 1,
        id: "local-hs37d5-hg19".into(),
        assembly: "b37".into(),
        contig_style: "no_chr_prefix".into(),
        reference_path: "/media/mrueda/2TBS/Databases/genomes/hs37d5.fa.gz".into(),
        reference_fai_path: "/media/mrueda/2TBS/Databases/genomes/hs37d5.fa.gz.fai".into(),
        reference_gzi_path: Some("/media/mrueda/2TBS/Databases/genomes/hs37d5.fa.gz.gzi".into()),
        java_path: "/usr/bin/java".into(),
        snpeff_jar_path: "/media/mrueda/2TBS/NGSutils/snpEff_v5.0/snpEff.jar".into(),
        snpeff_config_path: Some("/media/mrueda/2TBS/NGSutils/snpEff_v5.0/snpEff.config".into()),
        snpeff_genome: "hg19".into(),
        snpeff_version: "5.0e".into(),
        bcftools_path: "/media/mrueda/2TBS/NGSutils/bcftools-1.21-103_arm64/bcftools".into(),
        bgzip_path: "/usr/local/bin/bgzip".into(),
        tabix_path: "/usr/local/bin/tabix".into(),
        dbnsfp: IndexedResource {
            path: "/media/mrueda/2TBS/Databases/snpeff/v5.0/hg19/dbNSFP4.1a_hg19.txt.gz".into(),
            index_path: "/media/mrueda/2TBS/Databases/snpeff/v5.0/hg19/dbNSFP4.1a_hg19.txt.gz.tbi".into(),
            release: "dbNSFP 4.1a".into(),
            license_label: "user-supplied".into(),
            fingerprint: None,
        },
        clinvar: IndexedResource {
            path: "/media/mrueda/2TBS/Databases/snpeff/v5.0/hg19/clinvar_20250312.vcf.gz".into(),
            index_path: "/media/mrueda/2TBS/Databases/snpeff/v5.0/hg19/clinvar_20250312.vcf.gz.tbi".into(),
            release: "ClinVar 20250312".into(),
            license_label: "user-supplied".into(),
            fingerprint: None,
        },
        cosmic: IndexedResource {
            path: "/media/mrueda/2TBS/Databases/snpeff/v5.0/hg19/CosmicCodingMuts.normal.hg19.vcf.gz".into(),
            index_path: "/media/mrueda/2TBS/Databases/snpeff/v5.0/hg19/CosmicCodingMuts.normal.hg19.vcf.gz.tbi".into(),
            release: "COSMIC local snapshot".into(),
            license_label: "user-supplied; not redistributed".into(),
            fingerprint: None,
        },
        bundle_fingerprint: None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            evaluation: Arc::new(EvaluationService::new()),
            job_lock: Arc::new(Mutex::new(())),
            cancelled_jobs: Arc::new(Mutex::new(BTreeSet::new())),
        })
        .invoke_handler(tauri::generate_handler![
            inspect_vcf_file,
            validate_bundle,
            device_catalog,
            create_project,
            create_project_from_current,
            open_project,
            focus_region,
            export_focus_fasta,
            track_deck,
            variant_page,
            variant_contigs,
            variant_navigation_bins,
            variant_density,
            resolve_variant_selection,
            save_workspace,
            select_track,
            duplicate_track,
            rename_track,
            delete_track,
            consolidate_track,
            preview_randomizer,
            start_randomizer_preview_job,
            background_job,
            list_background_jobs,
            cancel_background_job,
            start_track_evidence_profile_job,
            run_randomizer,
            apply_compound_mutation_layer,
            run_optimizer,
            set_track_edit_bypass,
            set_track_edits_bypass,
            apply_edit,
            evaluate_variant,
            evaluate_device,
            render_state,
            render_track,
            example_fixture,
            suggested_development_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running DGW");
}

#[cfg(test)]
mod tests {
    use super::*;
    use dgw_core::{RandomizerProposal, SubstitutionPattern, VariantKey};

    #[test]
    fn randomizer_preview_keeps_totals_but_bounds_change_details() {
        let proposals = (1..=250)
            .map(|position| {
                let source_variant = VariantKey {
                    assembly: "GRCh37".into(),
                    contig: "1".into(),
                    position,
                    reference: "A".into(),
                    alternate: "C".into(),
                };
                let replacement_variant = VariantKey {
                    alternate: "G".into(),
                    ..source_variant.clone()
                };
                RandomizerProposal {
                    source_variant: source_variant.clone(),
                    replacement_variant: replacement_variant.clone(),
                    haplotype: Haplotype::One,
                    edit: EditKind::SetAllele {
                        key: replacement_variant,
                        source_key: Some(source_variant),
                    },
                }
            })
            .collect();
        let preview = compact_randomizer_preview(&RandomizerPlan {
            request: RandomizerRequest {
                selected_variants: Vec::new(),
                amount: 100,
                seed: 1,
                substitution_pattern: SubstitutionPattern::Uniform,
                transition_probability: 67,
            },
            proposals,
            exclusions: Vec::new(),
            selected_positions: 250,
            randomized_positions: 250,
            transition_positions: 250,
            transversion_positions: 0,
            generated_edits: 250,
            no_op_reason: None,
            limitation: "test".into(),
        });

        assert_eq!(preview.change_count, 250);
        assert_eq!(preview.changes.len(), RANDOMIZER_PREVIEW_CHANGE_LIMIT);
        assert_eq!(preview.randomized_positions, 250);
    }
}
