use dgw_core::evaluation::{normalize_variant, BatchEvidenceSignal};
use dgw_core::{
    built_in_device_manifest, built_in_device_manifests, inspect_vcf, plan_optimizer_with_evidence,
    plan_randomizer, plan_track_morph, validate_resource_bundle, BackgroundJob,
    BackgroundJobStatus, CompoundMutationChange, CreateProjectRequest, DeviceManifest,
    DeviceRunRecord, DeviceRunStatus, EditKind, EditOperation, EffectiveVariant, EvaluationResult,
    EvaluationService, EvidenceResult, EvidenceStatus, FocusContext, FocusFastaExport, FocusView,
    GeneSearchHit, GenomeState, GenomeTrack, Haplotype, LocalComputePool,
    OptimizerAlleleEvidenceInput, OptimizerDirection, OptimizerMode, OptimizerObjective,
    OptimizerPlan, OptimizerRequest, ProcessProgress, Project, ProjectSnapshot, RandomizerPlan,
    RandomizerPreviewResult, RandomizerRequest, ResourceBundle, SaturationAlleleInput,
    SelectionResolution, TrackMorphRequest, TransportTargetRequest, TransportTargetResult,
    VariantContigSummary, VariantDensity, VariantNavigationBin, VariantPage, VariantSelection,
    VcfInspection, WorkspaceSnapshot, CONSEQUENCE_DEVICE_ID,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager};
use uuid::Uuid;

struct AppState {
    evaluation: Arc<EvaluationService>,
    compute_pool: Arc<LocalComputePool>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ResourceHealthStatus {
    Ready,
    Warning,
    Missing,
    NotConfigured,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceHealthItem {
    id: &'static str,
    label: &'static str,
    status: ResourceHealthStatus,
    summary: String,
    paths: Vec<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectResourceHealth {
    bundle_id: String,
    assembly: String,
    checked_at: chrono::DateTime<chrono::Utc>,
    status: ResourceHealthStatus,
    items: Vec<ResourceHealthItem>,
}

fn file_health(
    id: &'static str,
    label: &'static str,
    release: &str,
    paths: Vec<PathBuf>,
    configured: bool,
    required: bool,
) -> ResourceHealthItem {
    if !configured {
        return ResourceHealthItem {
            id,
            label,
            status: if required {
                ResourceHealthStatus::Missing
            } else {
                ResourceHealthStatus::NotConfigured
            },
            summary: if required {
                "Required resource is not configured".into()
            } else {
                "Optional resource is not configured".into()
            },
            paths,
        };
    }
    let missing: Vec<_> = paths
        .iter()
        .filter(|path| !path.is_file())
        .map(|path| path.display().to_string())
        .collect();
    ResourceHealthItem {
        id,
        label,
        status: if missing.is_empty() {
            ResourceHealthStatus::Ready
        } else {
            ResourceHealthStatus::Missing
        },
        summary: if missing.is_empty() {
            release.to_owned()
        } else {
            format!("Missing {}", missing.join(", "))
        },
        paths,
    }
}

fn toolchain_health(bundle: &ResourceBundle) -> ResourceHealthItem {
    let paths = vec![
        bundle.bcftools_path.clone(),
        bundle.bgzip_path.clone(),
        bundle.tabix_path.clone(),
    ];
    let mut item = file_health(
        "toolchain",
        "bcftools toolchain",
        &format!("bcftools {} · bgzip · tabix", bundle.bcftools_version),
        paths,
        true,
        true,
    );
    if item.status != ResourceHealthStatus::Ready {
        return item;
    }
    match Command::new(&bundle.bcftools_path)
        .arg("--version-only")
        .output()
    {
        Ok(output) if output.status.success() => {
            let observed = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !bundle.bcftools_version.is_empty()
                && !observed.starts_with(&bundle.bcftools_version)
            {
                item.status = ResourceHealthStatus::Warning;
                item.summary = format!(
                    "Configured {}, executable reports {}",
                    bundle.bcftools_version, observed
                );
            } else {
                item.summary = format!("bcftools {observed} · bgzip · tabix");
            }
        }
        Ok(output) => {
            item.status = ResourceHealthStatus::Error;
            item.summary = format!(
                "bcftools could not run: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Err(error) => {
            item.status = ResourceHealthStatus::Error;
            item.summary = format!("bcftools could not run: {error}");
        }
    }
    item
}

fn report_status(items: &[ResourceHealthItem]) -> ResourceHealthStatus {
    if items
        .iter()
        .any(|item| item.status == ResourceHealthStatus::Error)
    {
        ResourceHealthStatus::Error
    } else if items.iter().any(|item| {
        item.status == ResourceHealthStatus::Missing && matches!(item.id, "toolchain" | "reference")
    }) {
        ResourceHealthStatus::Missing
    } else if items.iter().any(|item| {
        matches!(
            item.status,
            ResourceHealthStatus::Missing | ResourceHealthStatus::Warning
        )
    }) {
        ResourceHealthStatus::Warning
    } else {
        ResourceHealthStatus::Ready
    }
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
    source_variant_total: u64,
    variants_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimizerRunResult {
    plan: OptimizerPlan,
    generated_edit_ids: Vec<String>,
    snapshot: ProjectSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimizerBackgroundResult {
    mode: OptimizerMode,
    direction: OptimizerDirection,
    considered_positions: u32,
    evaluated_candidates: u32,
    excluded_positions: u32,
    improving_positions: u32,
    unchanged_or_tied_positions: u32,
    deferred_by_change_limit: u32,
    changed_positions: u32,
    generated_edits: u32,
    score_before: f64,
    score_after: f64,
    score_description: String,
    limitation: String,
    no_op_reason: Option<String>,
    candidate_comparisons_retained: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    compound_layer_id: Option<String>,
}

struct BulkOptimizerGroup {
    source_variant: dgw_core::VariantKey,
    changes: Vec<CompoundMutationChange>,
    score_delta: f64,
    improvement: f64,
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

const RANDOMIZER_INTERACTIVE_MATERIALIZATION_LIMIT: u32 = 1_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackMorphPreviewResult {
    source_track_id: String,
    source_state_id: String,
    target_track_id: String,
    target_state_id: String,
    amount: u8,
    differing_positions: u32,
    differing_alleles: u32,
    selected_positions: u32,
    generated_edits: u32,
    no_op_reason: Option<String>,
    limitation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    compound_layer_id: Option<String>,
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

fn resolve_optimizer_request(
    project: &Project,
    track_id: &str,
    mut request: OptimizerRequest,
    selection: Option<VariantSelection>,
    selection_limit: Option<u32>,
) -> Result<OptimizerRequest, String> {
    if let Some(selection) = selection {
        let limit = selection_limit
            .unwrap_or(dgw_core::MAX_SATURATION_POSITIONS as u32)
            .min(dgw_core::MAX_SATURATION_POSITIONS as u32)
            .max(1);
        let resolution = project
            .resolve_selection(&selection, limit)
            .map_err(error_text)?;
        if resolution.track_id != track_id {
            return Err("Genome Optimizer selection belongs to a different track".into());
        }
        if resolution.truncated {
            return Err(format!(
                "{} alleles are selected; Genome Optimizer accepts at most {} positions for this run",
                resolution.total, limit
            ));
        }
        request.selected_variants = resolution.variants;
    }
    if request.selected_variants.is_empty() {
        return Err("Select at least one active allele before running Genome Optimizer".into());
    }
    if request.selected_variants.len() > dgw_core::MAX_SATURATION_POSITIONS {
        return Err(format!(
            "Genome Optimizer accepts at most {} positions per run",
            dgw_core::MAX_SATURATION_POSITIONS
        ));
    }
    if request.max_edits == 0 || request.max_edits > dgw_core::MAX_OPTIMIZER_EDITS {
        return Err(format!(
            "Genome Optimizer changes must be between 1 and {} positions",
            dgw_core::MAX_OPTIMIZER_EDITS
        ));
    }
    Ok(request)
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

fn optimizer_candidate_variants(selected: &[dgw_core::VariantKey]) -> Vec<dgw_core::VariantKey> {
    let mut candidates = BTreeMap::new();
    for source in selected {
        if source.reference.len() != 1
            || source.alternate.len() != 1
            || !matches!(
                source.reference.as_bytes()[0].to_ascii_uppercase(),
                b'A' | b'C' | b'G' | b'T'
            )
        {
            continue;
        }
        let reference = source.reference.as_bytes()[0].to_ascii_uppercase();
        for alternate in [b'A', b'C', b'G', b'T']
            .into_iter()
            .filter(|alternate| *alternate != reference)
        {
            let candidate = dgw_core::VariantKey {
                assembly: source.assembly.clone(),
                contig: source.contig.clone(),
                position: source.position,
                reference: char::from(reference).to_string(),
                alternate: char::from(alternate).to_string(),
            };
            candidates
                .entry(candidate.stable_key())
                .or_insert(candidate);
        }
    }
    candidates.into_values().collect()
}

fn optimizer_groups_from_plan(plan: &OptimizerPlan) -> Vec<BulkOptimizerGroup> {
    let mut grouped: BTreeMap<String, BulkOptimizerGroup> = BTreeMap::new();
    for proposal in &plan.proposals {
        let key = proposal.source_variant.stable_key();
        let group = grouped.entry(key).or_insert_with(|| BulkOptimizerGroup {
            source_variant: proposal.source_variant.clone(),
            changes: Vec::new(),
            score_delta: 0.0,
            improvement: 0.0,
        });
        group.changes.push(CompoundMutationChange {
            haplotype: proposal.haplotype,
            edit: proposal.edit.clone(),
        });
        group.score_delta += proposal.score_delta;
    }
    for group in grouped.values_mut() {
        group.improvement = group.score_delta.abs();
    }
    grouped.into_values().collect()
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
    project.save_background_job(job).map_err(error_text)?;
    persist_terminal_device_run(project, job)
}

fn persist_terminal_device_run(project: &Project, job: &BackgroundJob) -> Result<(), String> {
    project.persist_terminal_device_run(job).map_err(error_text)
}

#[allow(clippy::too_many_arguments)]
fn save_completed_device_run(
    project: &Project,
    device_id: &str,
    operation: &str,
    track_id: &str,
    input_state_id: &str,
    selection: serde_json::Value,
    parameters: serde_json::Value,
    result_summary: serde_json::Value,
    output_edit_ids: Vec<String>,
    started_at: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    let manifest = built_in_device_manifest(device_id)
        .ok_or_else(|| format!("unknown built-in device {device_id}"))?;
    let input_fingerprint = project
        .device_run_input_fingerprint(
            device_id,
            &manifest.version,
            track_id,
            input_state_id,
            &selection,
            &parameters,
        )
        .map_err(error_text)?;
    let limitation = result_summary
        .get("limitation")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| manifest.scientific_limitations.join(" "));
    project
        .save_device_run(&DeviceRunRecord {
            id: Uuid::new_v4().to_string(),
            device_id: device_id.into(),
            device_version: manifest.version,
            operation: operation.into(),
            track_id: track_id.into(),
            input_state_id: input_state_id.into(),
            input_fingerprint,
            selection,
            parameters,
            resource_bundle_fingerprint: project.manifest().resource_bundle_fingerprint.clone(),
            resource_context: project.device_run_resource_context(),
            compound_layer_id: None,
            result_summary,
            output_edit_ids,
            status: DeviceRunStatus::Completed,
            error: None,
            limitation,
            started_at,
            completed_at: chrono::Utc::now(),
        })
        .map_err(error_text)
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
fn example_fixture(
    app: tauri::AppHandle,
    assembly: String,
    example_id: Option<String>,
) -> Result<ExampleFixture, String> {
    let example_id = example_id.as_deref().unwrap_or("alleleEditing");
    let (file_name, sample, project_name, project_stem) = match (assembly.as_str(), example_id) {
        ("b37", "alleleEditing") => (
            "dgw-cluster.synthetic.vcf",
            "DGW_DEMO",
            "DGW Allele Editing — GRCh37",
            "dgw-allele-editing-grch37-example",
        ),
        ("hg38", "alleleEditing") => (
            "dgw-cluster.grch38.synthetic.vcf",
            "DGW_DEMO",
            "DGW Allele Editing — GRCh38",
            "dgw-allele-editing-grch38-example",
        ),
        ("b37", "hg00103Wes") => (
            "1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz",
            "SRR1596639",
            "HG00103 exome — GRCh37",
            "hg00103-wes-grch37-example",
        ),
        _ => {
            return Err(format!(
                "no bundled example {example_id} is available for assembly {assembly}"
            ))
        }
    };
    let development_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(file_name);
    let path = if development_path.is_file() {
        development_path
    } else {
        app.path()
            .resolve(
                format!("fixtures/{file_name}"),
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

    let unsaved_examples_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(error_text)?
        .join("unsaved-examples");

    Ok(ExampleFixture {
        path,
        sample: sample.into(),
        project_name: project_name.into(),
        project_path: unsaved_examples_dir.join(format!("{project_stem}-{}.dgw", Uuid::new_v4())),
    })
}

#[tauri::command]
async fn inspect_vcf_file(
    path: PathBuf,
    assembly: Option<String>,
    on_progress: Channel<ProcessProgress>,
) -> Result<VcfInspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
        let inspection =
            inspect_vcf(path, assembly.as_deref().unwrap_or("b37")).map_err(error_text)?;
        let _ = on_progress.send(ProcessProgress::new(
            "vcfInspection",
            "summary",
            "VCF inspection complete",
            3,
            3,
        ));
        Ok(inspection)
    })
    .await
    .map_err(|error| format!("VCF inspection worker failed: {error}"))?
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
async fn create_project(
    request: CreateProjectRequest,
    on_progress: Channel<ProcessProgress>,
) -> Result<ProjectSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|error| format!("VCF import worker failed: {error}"))?
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
fn project_resource_health(project_path: PathBuf) -> Result<ProjectResourceHealth, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let bundle = &project.manifest().resource_bundle;
    let mut reference_paths = vec![
        bundle.reference_path.clone(),
        bundle.reference_fai_path.clone(),
    ];
    if let Some(path) = &bundle.reference_gzi_path {
        reference_paths.push(path.clone());
    }
    let mut items = vec![
        toolchain_health(bundle),
        file_health(
            "reference",
            "Reference FASTA",
            &format!("{} reference and indexes", bundle.assembly),
            reference_paths,
            true,
            true,
        ),
    ];
    items.push(match &bundle.consequence_annotation {
        Some(resource) => file_health(
            "consequence",
            "Variant consequences",
            &resource.release,
            vec![resource.path.clone()],
            true,
            false,
        ),
        None => file_health(
            "consequence",
            "Variant consequences",
            "",
            Vec::new(),
            false,
            false,
        ),
    });
    items.push(match &bundle.gene_annotation {
        Some(resource) => file_health(
            "genes",
            "Gene navigation",
            &resource.release,
            vec![resource.path.clone(), resource.index_path.clone()],
            true,
            false,
        ),
        None => file_health("genes", "Gene navigation", "", Vec::new(), false, false),
    });
    for (id, label, resource) in [
        ("dbnsfp", "dbNSFP", &bundle.dbnsfp),
        ("clinvar", "ClinVar", &bundle.clinvar),
        ("cosmic", "COSMIC", &bundle.cosmic),
    ] {
        items.push(file_health(
            id,
            label,
            &resource.release,
            vec![resource.path.clone(), resource.index_path.clone()],
            !resource.path.as_os_str().is_empty(),
            false,
        ));
    }
    Ok(ProjectResourceHealth {
        bundle_id: bundle.id.clone(),
        assembly: bundle.assembly.clone(),
        checked_at: chrono::Utc::now(),
        status: report_status(&items),
        items,
    })
}

#[tauri::command]
fn load_workstation_session(project_path: PathBuf) -> Result<Option<serde_json::Value>, String> {
    Project::open(project_path)
        .and_then(|project| project.workstation_session())
        .map_err(error_text)
}

#[tauri::command]
fn save_workstation_session(
    project_path: PathBuf,
    session: serde_json::Value,
) -> Result<String, String> {
    Project::open(project_path)
        .and_then(|project| project.save_workstation_session(&session))
        .map_err(error_text)
}

#[tauri::command]
fn save_project_copy(
    project_path: PathBuf,
    destination_path: PathBuf,
) -> Result<CreatedProject, String> {
    let copied = Project::open(project_path)
        .and_then(|project| project.save_copy(&destination_path))
        .map_err(error_text)?;
    Ok(CreatedProject {
        project_path: destination_path,
        snapshot: copied.snapshot().map_err(error_text)?,
    })
}

#[tauri::command]
fn focus_region(project_path: PathBuf, context: FocusContext) -> Result<FocusView, String> {
    Project::open(project_path)
        .and_then(|project| project.focus_view(context))
        .map_err(error_text)
}

#[tauri::command]
fn search_genes(
    project_path: PathBuf,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<GeneSearchHit>, String> {
    Project::open(project_path)
        .and_then(|project| project.search_genes(&query, limit.unwrap_or(12)))
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
            let (variants, source_variant_total, variants_truncated) = match &context {
                Some(context) => {
                    let total = project
                        .source_variant_count_in_context(context)
                        .map_err(error_text)?;
                    if total > dgw_core::MAX_TRACK_REGION_VARIANTS as u64 {
                        (Vec::new(), total, true)
                    } else {
                        (
                            project
                                .effective_variants_for_track_in_context(&track.id, context)
                                .map_err(error_text)?,
                            total,
                            false,
                        )
                    }
                }
                None => {
                    let page = project
                        .variant_page(&track.id, 0, dgw_core::VARIANT_PAGE_SIZE)
                        .map_err(error_text)?;
                    let truncated = page.has_more;
                    (page.variants, page.total, truncated)
                }
            };
            Ok(GenomeTrackLane {
                track,
                edits,
                variants,
                source_variant_total,
                variants_truncated,
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
fn transport_target(
    project_path: PathBuf,
    request: TransportTargetRequest,
) -> Result<TransportTargetResult, String> {
    Project::open(project_path)
        .and_then(|project| project.transport_target(&request))
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
fn track_profile_input_fingerprint(
    project_path: PathBuf,
    track_id: String,
    device_ids: Vec<String>,
) -> Result<String, String> {
    Project::open(project_path)
        .and_then(|project| project.track_profile_input_fingerprint(&track_id, &device_ids))
        .map_err(error_text)
}

#[tauri::command]
fn consolidate_track(project_path: PathBuf, track_id: String) -> Result<ProjectSnapshot, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project.consolidate_track(&track_id).map_err(error_text)?;
    project.snapshot().map_err(error_text)
}

#[tauri::command]
async fn run_optimizer(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    track_id: String,
    focus: FocusContext,
    request: OptimizerRequest,
) -> Result<OptimizerRunResult, String> {
    let evaluation = Arc::clone(&state.evaluation);
    tauri::async_runtime::spawn_blocking(move || {
        let started_at = chrono::Utc::now();
        if request.selected_variants.is_empty() {
            return Err(
                "Select at least one active allele before running Genome Optimizer.".into(),
            );
        }
        let project = Project::open(project_path).map_err(error_text)?;
        let input_state_id = project.track(&track_id).map_err(error_text)?.head_state_id;
        let current = project
            .effective_variants_for_track_at_loci(&track_id, &request.selected_variants)
            .map_err(error_text)?;
        let plan = match request.mode {
            OptimizerMode::Conservative => {
                let source = project
                    .source_variants_at_loci(&request.selected_variants)
                    .map_err(error_text)?;
                let evaluated = evaluate_conservative_alleles(
                    &evaluation,
                    &project,
                    &current,
                    &source,
                    &request,
                )?;
                plan_optimizer_with_evidence(&current, &source, &focus, &request, &evaluated)
                    .map_err(error_text)?
            }
            OptimizerMode::Saturation => {
                let evaluated = evaluate_saturation_candidates(&evaluation, &project, &request)?;
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
            .collect::<Vec<_>>();
        save_completed_device_run(
            &project,
            "org.dgw.builtin.genome-optimizer",
            "genomeOptimizer",
            &track_id,
            &input_state_id,
            serde_json::json!({"selectedVariants": &request.selected_variants}),
            serde_json::to_value(&request).map_err(error_text)?,
            serde_json::json!({
                "consideredVariants": plan.considered_variants,
                "eligibleCandidates": plan.eligible_candidates,
                "excludedCandidates": plan.exclusions.len(),
                "changedPositions": plan.proposals.len(),
                "scoreBefore": plan.score_before,
                "scoreAfter": plan.score_after,
                "scoreDescription": &plan.score_description,
                "noOpReason": &plan.no_op_reason,
                "limitation": &plan.limitation,
            }),
            generated_edit_ids.clone(),
            started_at,
        )?;
        let snapshot = project.snapshot().map_err(error_text)?;
        Ok(OptimizerRunResult {
            plan,
            generated_edit_ids,
            snapshot,
        })
    })
    .await
    .map_err(|error| format!("Genome Optimizer worker failed: {error}"))?
}

fn evaluate_conservative_alleles(
    evaluation: &EvaluationService,
    project: &Project,
    current: &[EffectiveVariant],
    source: &[EffectiveVariant],
    request: &OptimizerRequest,
) -> Result<Vec<OptimizerAlleleEvidenceInput>, String> {
    const CLINVAR: &str = "org.dgw.builtin.clinvar";
    let need_consequence = request.objective == OptimizerObjective::PredictedImpactBurden
        && request.weights.impact > 0.0;
    let need_clinvar_guard = request.direction == OptimizerDirection::Maximize;
    if need_consequence
        && !request
            .evidence_device_ids
            .iter()
            .any(|device_id| device_id == CONSEQUENCE_DEVICE_ID)
    {
        return Err(
            "Weighted annotation burden requires applied, active Variant Consequences.".into(),
        );
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
        let consequence = if need_consequence {
            evaluation
                .evaluate_device(project, &key, CONSEQUENCE_DEVICE_ID)
                .map_err(error_text)?
        } else {
            not_computed_evidence("Variant Consequences")
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
            consequence,
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
    evaluation
        .evaluate_saturation_candidates(project, request)
        .map_err(error_text)
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
        let source_state_id = project.track(&track_id).map_err(error_text)?.head_state_id;
        project
            .prepare_randomizer_preview(
                &track_id,
                &source_state_id,
                request,
                selection.as_ref(),
                selection_limit,
                false,
            )
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
    let _ = worker_threads;
    let project = Project::open(&project_path).map_err(error_text)?;
    let source_state_id = project.track(&track_id).map_err(error_text)?.head_state_id;
    let now = chrono::Utc::now();
    let request_payload = serde_json::json!({
        "request": &request,
        "selection": &selection,
        "selectionLimit": selection_limit,
        "sourceStateId": source_state_id,
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
        worker_threads: 1,
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
            if job_was_cancelled(&cancelled_jobs, &job.id) {
                return Err("__cancelled__".into());
            }
            update_job(
                &project,
                &mut job,
                BackgroundJobStatus::Running,
                70,
                "planning",
                "Planning changes across the selected variants",
            )?;
            project
                .prepare_randomizer_preview(
                    &track_id,
                    &source_state_id,
                    request,
                    selection.as_ref(),
                    selection_limit,
                    true,
                )
                .map_err(error_text)
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
fn start_optimizer_job(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    track_id: String,
    focus: FocusContext,
    request: OptimizerRequest,
    selection: Option<VariantSelection>,
    selection_limit: Option<u32>,
    worker_threads: Option<u16>,
) -> Result<BackgroundJob, String> {
    let _ = worker_threads;
    let project = Project::open(&project_path).map_err(error_text)?;
    let track = project.track(&track_id).map_err(error_text)?;
    if track.read_only {
        return Err("Duplicate the read-only source track before running Genome Optimizer".into());
    }
    let source_state_id = track.head_state_id.clone();
    let now = chrono::Utc::now();
    let mut job = BackgroundJob {
        id: Uuid::new_v4().to_string(),
        operation: "genomeOptimizer".into(),
        device_id: "org.dgw.builtin.genome-optimizer".into(),
        track_id: track_id.clone(),
        status: BackgroundJobStatus::Queued,
        progress: 0,
        stage: "queued".into(),
        message: "Waiting for the background compute slot".into(),
        worker_threads: 1,
        request: serde_json::json!({
            "optimizer": &request,
            "selection": &selection,
            "selectionLimit": selection_limit,
            "sourceStateId": &source_state_id,
        }),
        result: None,
        error: None,
        created_at: now,
        updated_at: now,
    };
    project.save_background_job(&job).map_err(error_text)?;

    let returned_job = job.clone();
    let job_lock = Arc::clone(&state.job_lock);
    let cancelled_jobs = Arc::clone(&state.cancelled_jobs);
    let evaluation = Arc::clone(&state.evaluation);
    tauri::async_runtime::spawn_blocking(move || {
        let lock = match job_lock.lock() {
            Ok(lock) => lock,
            Err(error) => {
                let message = format!("background compute lock failed: {error}");
                job.error = Some(message.clone());
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
        let job_id = job.id.clone();
        let cancelled = || job_was_cancelled(&cancelled_jobs, &job_id);
        let outcome = (|| -> Result<OptimizerBackgroundResult, String> {
            if cancelled() {
                return Err("__cancelled__".into());
            }
            update_job(
                &project,
                &mut job,
                BackgroundJobStatus::Running,
                3,
                "selection",
                "Resolving the selected genome positions",
            )?;
            let request = resolve_optimizer_request(
                &project,
                &track_id,
                request,
                selection,
                selection_limit,
            )?;
            let has_consequence = request
                .evidence_device_ids
                .iter()
                .any(|device_id| device_id == CONSEQUENCE_DEVICE_ID);
            let has_clinvar = request
                .evidence_device_ids
                .iter()
                .any(|device_id| device_id == "org.dgw.builtin.clinvar");
            if request.mode == OptimizerMode::Saturation && (!has_consequence || !has_clinvar) {
                return Err(
                    "Saturation requires applied, active Variant Consequences and ClinVar devices"
                        .into(),
                );
            }
            if request.mode == OptimizerMode::Conservative
                && request.objective == OptimizerObjective::PredictedImpactBurden
                && request.weights.impact > 0.0
                && !has_consequence
            {
                return Err(
                    "Weighted annotation burden requires applied, active Variant Consequences"
                        .into(),
                );
            }
            if request.mode == OptimizerMode::Conservative
                && request.direction == OptimizerDirection::Maximize
                && !has_clinvar
            {
                return Err(
                    "Conservative Maximize requires an applied, active ClinVar guard".into(),
                );
            }
            let considered_positions = request.selected_variants.len() as u32;
            let mut groups = Vec::new();
            let mut score_before = 0.0;
            let mut evaluated_candidates = 0_u32;
            let mut excluded_positions = 0_u32;
            let mut score_description = match request.mode {
                OptimizerMode::Saturation => "Comparable normalized transcript-consequence impact per allele copy across all non-reference SNV bases at the selected positions.".into(),
                OptimizerMode::Conservative => "Number of alternate allele copies in the selected scope; this measures distance from the reference, not biological burden.".into(),
            };
            let mut limitation = dgw_core::ADDITIVE_SCORE_LIMITATION.to_owned();

            match request.mode {
                OptimizerMode::Saturation => {
                    const POSITION_CHUNK_SIZE: usize = 100_000;
                    let chunk_count = request
                        .selected_variants
                        .len()
                        .div_ceil(POSITION_CHUNK_SIZE)
                        .max(1);
                    for (chunk_index, selected_chunk) in request
                        .selected_variants
                        .chunks(POSITION_CHUNK_SIZE)
                        .enumerate()
                    {
                        if cancelled() {
                            return Err("__cancelled__".into());
                        }
                        let current = project
                            .effective_variants_for_track_at_loci(&track_id, selected_chunk)
                            .map_err(error_text)?;
                        let candidates = optimizer_candidate_variants(selected_chunk);
                        evaluated_candidates = evaluated_candidates
                            .saturating_add(candidates.len().min(u32::MAX as usize) as u32);
                        let chunk_base = 8.0 + (chunk_index as f64 / chunk_count as f64) * 74.0;
                        let chunk_span = 74.0 / chunk_count as f64;
                        update_job(
                            &project,
                            &mut job,
                            BackgroundJobStatus::Running,
                            chunk_base.round() as u8,
                            "consequences",
                            format!(
                                "Predicting consequence batch {} of {} · {} alleles",
                                chunk_index + 1,
                                chunk_count,
                                candidates.len()
                            ),
                        )?;
                        let consequence = evaluation
                            .evaluate_device_signals(
                                &project,
                                &candidates,
                                CONSEQUENCE_DEVICE_ID,
                                |processed, total| {
                                    let fraction = if total == 0 {
                                        1.0
                                    } else {
                                        processed as f64 / total as f64
                                    };
                                    let progress = chunk_base + chunk_span * 0.58 * fraction;
                                    let _ = update_job(
                                        &project,
                                        &mut job,
                                        BackgroundJobStatus::Running,
                                        progress.round() as u8,
                                        "consequences",
                                        format!(
                                            "Variant Consequences batch {} of {} · {}/{} candidate alleles",
                                            chunk_index + 1,
                                            chunk_count,
                                            processed,
                                            total
                                        ),
                                    );
                                    Ok(())
                                },
                            )
                            .map_err(error_text)?;
                        if cancelled() {
                            return Err("__cancelled__".into());
                        }
                        let clinvar = evaluation
                            .evaluate_device_signals(
                                &project,
                                &candidates,
                                "org.dgw.builtin.clinvar",
                                |processed, total| {
                                    let fraction = if total == 0 {
                                        1.0
                                    } else {
                                        processed as f64 / total as f64
                                    };
                                    let progress = chunk_base
                                        + chunk_span * (0.58 + 0.30 * fraction);
                                    let _ = update_job(
                                        &project,
                                        &mut job,
                                        BackgroundJobStatus::Running,
                                        progress.round() as u8,
                                        "clinvar",
                                        format!(
                                            "ClinVar guard batch {} of {} · {}/{} candidate alleles",
                                            chunk_index + 1,
                                            chunk_count,
                                            processed,
                                            total
                                        ),
                                    );
                                    Ok(())
                                },
                            )
                            .map_err(error_text)?;
                        let mut evaluated = Vec::with_capacity(candidates.len());
                        for source in selected_chunk {
                            for candidate in candidates.iter().filter(|candidate| {
                                candidate.assembly == source.assembly
                                    && candidate.contig == source.contig
                                    && candidate.position == source.position
                                    && candidate.reference.eq_ignore_ascii_case(&source.reference)
                            }) {
                                let consequence_signal =
                                    consequence.get(candidate).ok_or_else(|| {
                                        format!(
                                            "Variant Consequences omitted candidate {}",
                                            candidate.display()
                                        )
                                    })?;
                                let clinvar_signal = clinvar.get(candidate).ok_or_else(|| {
                                    format!("ClinVar omitted candidate {}", candidate.display())
                                })?;
                                let clinvar_evidence = evidence_from_batch_signal(
                                    &project.manifest().resource_bundle.clinvar.release,
                                    clinvar_signal,
                                );
                                evaluated.push(SaturationAlleleInput {
                                    source_variant: source.clone(),
                                    candidate_variant: candidate.clone(),
                                    consequence: evidence_from_batch_signal(
                                        "Variant Consequences",
                                        consequence_signal,
                                    ),
                                    clinvar: clinvar_evidence.clone(),
                                    evidence_statuses: BTreeMap::from([
                                        (
                                            CONSEQUENCE_DEVICE_ID.into(),
                                            evidence_status_label(&consequence_signal.status)
                                                .into(),
                                        ),
                                        (
                                            "org.dgw.builtin.clinvar".into(),
                                            evidence_status_label(&clinvar_signal.status).into(),
                                        ),
                                    ]),
                                    exact_evidence_sources: (clinvar_signal.status
                                        == EvidenceStatus::Found)
                                        .then(|| clinvar_evidence.source.clone())
                                        .into_iter()
                                        .collect(),
                                });
                            }
                        }
                        let mut chunk_request = request.clone();
                        chunk_request.selected_variants = selected_chunk.to_vec();
                        chunk_request.max_edits = selected_chunk.len() as u32;
                        let plan = dgw_core::plan_saturation_optimizer(
                            &current,
                            &focus,
                            &chunk_request,
                            &evaluated,
                        )
                        .map_err(error_text)?;
                        score_before += plan.score_before;
                        excluded_positions = excluded_positions
                            .saturating_add(plan.exclusions.len().min(u32::MAX as usize) as u32);
                        score_description = plan.score_description.clone();
                        limitation = plan.limitation.clone();
                        groups.extend(optimizer_groups_from_plan(&plan));
                        update_job(
                            &project,
                            &mut job,
                            BackgroundJobStatus::Running,
                            (chunk_base + chunk_span).round() as u8,
                            "reduce",
                            format!(
                                "Reduced candidate batch {} of {} to per-position winners",
                                chunk_index + 1,
                                chunk_count
                            ),
                        )?;
                    }
                }
                OptimizerMode::Conservative => {
                    update_job(
                        &project,
                        &mut job,
                        BackgroundJobStatus::Running,
                        12,
                        "alleles",
                        "Reading current and source allele-copy states",
                    )?;
                    let current = project
                        .effective_variants_for_track_at_loci(&track_id, &request.selected_variants)
                        .map_err(error_text)?;
                    let source = project
                        .source_variants_at_loci(&request.selected_variants)
                        .map_err(error_text)?;
                    let mut keys = BTreeMap::new();
                    for variant in current.iter().chain(source.iter()) {
                        keys.entry(variant.key.stable_key())
                            .or_insert_with(|| variant.key.clone());
                    }
                    let keys: Vec<_> = keys.into_values().collect();
                    let need_consequence = request.objective
                        == OptimizerObjective::PredictedImpactBurden
                        && request.weights.impact > 0.0;
                    let need_clinvar = request.direction == OptimizerDirection::Maximize;
                    let consequence = if need_consequence {
                        evaluation
                            .evaluate_device_signals(
                                &project,
                                &keys,
                                CONSEQUENCE_DEVICE_ID,
                                |processed, total| {
                                    let progress = 18
                                        + if total == 0 {
                                            24
                                        } else {
                                            (processed * 24 / total) as u8
                                        };
                                    let _ = update_job(
                                        &project,
                                        &mut job,
                                        BackgroundJobStatus::Running,
                                        progress,
                                        "consequences",
                                        format!(
                                            "Variant Consequences · {processed}/{total} alleles"
                                        ),
                                    );
                                    Ok(())
                                },
                            )
                            .map_err(error_text)?
                    } else {
                        BTreeMap::new()
                    };
                    if cancelled() {
                        return Err("__cancelled__".into());
                    }
                    let source_keys: Vec<_> = source.iter().map(|item| item.key.clone()).collect();
                    let clinvar = if need_clinvar {
                        evaluation
                            .evaluate_device_signals(
                                &project,
                                &source_keys,
                                "org.dgw.builtin.clinvar",
                                |processed, total| {
                                    let progress = 45
                                        + if total == 0 {
                                            25
                                        } else {
                                            (processed * 25 / total) as u8
                                        };
                                    let _ = update_job(
                                        &project,
                                        &mut job,
                                        BackgroundJobStatus::Running,
                                        progress,
                                        "clinvar",
                                        format!("ClinVar guard · {processed}/{total} alleles"),
                                    );
                                    Ok(())
                                },
                            )
                            .map_err(error_text)?
                    } else {
                        BTreeMap::new()
                    };
                    evaluated_candidates = keys.len().min(u32::MAX as usize) as u32;
                    let evaluated: Vec<_> = keys
                        .iter()
                        .map(|key| OptimizerAlleleEvidenceInput {
                            variant: key.clone(),
                            consequence: consequence
                                .get(key)
                                .map(|signal| {
                                    evidence_from_batch_signal("Variant Consequences", signal)
                                })
                                .unwrap_or_else(|| not_computed_evidence("Variant Consequences")),
                            clinvar: clinvar
                                .get(key)
                                .map(|signal| {
                                    evidence_from_batch_signal(
                                        &project.manifest().resource_bundle.clinvar.release,
                                        signal,
                                    )
                                })
                                .unwrap_or_else(|| not_computed_evidence("ClinVar")),
                        })
                        .collect();
                    update_job(
                        &project,
                        &mut job,
                        BackgroundJobStatus::Running,
                        76,
                        "reduce",
                        "Ranking conservative source-allele candidates",
                    )?;
                    let plan = plan_optimizer_with_evidence(
                        &current, &source, &focus, &request, &evaluated,
                    )
                    .map_err(error_text)?;
                    score_before = plan.score_before;
                    excluded_positions = plan.exclusions.len().min(u32::MAX as usize) as u32;
                    score_description = plan.score_description.clone();
                    limitation = plan.limitation.clone();
                    groups.extend(optimizer_groups_from_plan(&plan));
                }
            }

            if cancelled() {
                return Err("__cancelled__".into());
            }
            groups.sort_by(|left, right| {
                right
                    .improvement
                    .partial_cmp(&left.improvement)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| left.source_variant.cmp(&right.source_variant))
            });
            let improving_positions = groups.len().min(u32::MAX as usize) as u32;
            let selected_groups: Vec<_> = groups
                .into_iter()
                .take(request.max_edits as usize)
                .collect();
            let changed_positions = selected_groups.len() as u32;
            let unchanged_or_tied_positions = considered_positions
                .saturating_sub(excluded_positions)
                .saturating_sub(improving_positions);
            let deferred_by_change_limit = improving_positions.saturating_sub(changed_positions);
            let score_delta: f64 = selected_groups.iter().map(|group| group.score_delta).sum();
            let changes: Vec<_> = selected_groups
                .into_iter()
                .flat_map(|group| group.changes)
                .collect();
            let generated_edits = changes.len().min(u32::MAX as usize) as u32;
            let no_op_reason = changes.is_empty().then(|| {
                "No selected position had an eligible allele that improved the requested objective."
                    .to_owned()
            });
            let compound_layer_id = if changes.is_empty() {
                None
            } else {
                update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Running,
                    90,
                    "staging",
                    format!(
                        "Storing {} changes across {} optimized positions",
                        generated_edits, changed_positions
                    ),
                )?;
                let note = format!(
                    "Genome Optimizer · {:?} · {:?} {:?} · {} positions",
                    request.mode, request.direction, request.objective, changed_positions
                );
                Some(
                    project
                        .stage_compound_mutation_layer(
                            &track_id,
                            &source_state_id,
                            "org.dgw.builtin.genome-optimizer",
                            changed_positions,
                            &changes,
                            Some(note),
                        )
                        .map_err(error_text)?
                        .id,
                )
            };
            Ok(OptimizerBackgroundResult {
                mode: request.mode,
                direction: request.direction,
                considered_positions,
                evaluated_candidates,
                excluded_positions,
                improving_positions,
                unchanged_or_tied_positions,
                deferred_by_change_limit,
                changed_positions,
                generated_edits,
                score_before,
                score_after: score_before + score_delta,
                score_description,
                limitation,
                no_op_reason,
                candidate_comparisons_retained: 0,
                compound_layer_id,
            })
        })();

        match outcome {
            Ok(result) => {
                let message = result.no_op_reason.clone().unwrap_or_else(|| {
                    format!(
                        "Optimizer prepared {} changes across {} positions",
                        result.generated_edits, result.changed_positions
                    )
                });
                job.result = serde_json::to_value(result).ok();
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
                    "Genome Optimizer job cancelled",
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
fn start_track_morph_preview_job(
    state: tauri::State<'_, AppState>,
    project_path: PathBuf,
    track_id: String,
    target_track_id: String,
    request: TrackMorphRequest,
    worker_threads: Option<u16>,
) -> Result<BackgroundJob, String> {
    let _ = worker_threads;
    if track_id == target_track_id {
        return Err("Genome Morph requires another track as its target".into());
    }
    let project = Project::open(&project_path).map_err(error_text)?;
    let source_track = project.track(&track_id).map_err(error_text)?;
    if source_track.read_only {
        return Err("Duplicate the read-only source track before applying Genome Morph".into());
    }
    let target_track = project.track(&target_track_id).map_err(error_text)?;
    let now = chrono::Utc::now();
    let mut job = BackgroundJob {
        id: Uuid::new_v4().to_string(),
        operation: "trackMorphPreview".into(),
        device_id: "org.dgw.builtin.genome-morph".into(),
        track_id: track_id.clone(),
        status: BackgroundJobStatus::Queued,
        progress: 0,
        stage: "queued".into(),
        message: "Waiting for the background compute slot".into(),
        worker_threads: 1,
        request: serde_json::json!({
            "sourceStateId": &source_track.head_state_id,
            "targetTrackId": &target_track_id,
            "targetStateId": &target_track.head_state_id,
            "morph": &request,
        }),
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
        let job_id = job.id.clone();
        let cancelled = || job_was_cancelled(&cancelled_jobs, &job_id);
        let outcome = (|| -> Result<TrackMorphPreviewResult, String> {
            if cancelled() {
                return Err("__cancelled__".into());
            }
            update_job(
                &project,
                &mut job,
                BackgroundJobStatus::Running,
                10,
                "source",
                format!("Reading effective state for {}", source_track.name),
            )?;
            let source = project
                .effective_variants_for_track(&track_id)
                .map_err(error_text)?;

            if cancelled() {
                return Err("__cancelled__".into());
            }
            update_job(
                &project,
                &mut job,
                BackgroundJobStatus::Running,
                35,
                "target",
                format!("Reading effective state for {}", target_track.name),
            )?;
            let target = project
                .effective_variants_for_track(&target_track_id)
                .map_err(error_text)?;

            if cancelled() {
                return Err("__cancelled__".into());
            }
            update_job(
                &project,
                &mut job,
                BackgroundJobStatus::Running,
                60,
                "difference",
                format!(
                    "Comparing {} and {} effective allele states",
                    source_track.name, target_track.name
                ),
            )?;
            let plan = plan_track_morph(&source, &target, &request).map_err(error_text)?;
            let mut compound_layer_id = None;
            if !plan.changes.is_empty() {
                if cancelled() {
                    return Err("__cancelled__".into());
                }
                update_job(
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
                    .stage_compound_mutation_layer(
                        &track_id,
                        &source_track.head_state_id,
                        "org.dgw.builtin.genome-morph",
                        plan.selected_positions,
                        &plan.changes,
                        Some(note),
                    )
                    .map_err(error_text)?;
                compound_layer_id = Some(layer.id);
            }
            Ok(TrackMorphPreviewResult {
                source_track_id: track_id.clone(),
                source_state_id: source_track.head_state_id.clone(),
                target_track_id: target_track_id.clone(),
                target_state_id: target_track.head_state_id.clone(),
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
            Ok(result) => {
                let message = format!(
                    "Morph preview prepared {} changes across {} positions",
                    result.generated_edits, result.selected_positions
                );
                job.result = serde_json::to_value(result).ok();
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
                    "Genome Morph preview cancelled",
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
fn list_device_runs(
    project_path: PathBuf,
    limit: Option<u32>,
) -> Result<Vec<DeviceRunRecord>, String> {
    Project::open(project_path)
        .and_then(|project| project.list_device_runs(limit.unwrap_or(100)))
        .map_err(error_text)
}

#[tauri::command]
fn delete_finished_background_jobs(project_path: PathBuf) -> Result<u64, String> {
    Project::open(project_path)
        .and_then(|project| project.delete_finished_background_jobs())
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
    let device_ids = dgw_core::normalized_track_profile_devices(&device_ids);
    if device_ids.is_empty() {
        return Err("Track Profiler requires at least one active Evidence device".into());
    }

    let project = Project::open(&project_path).map_err(error_text)?;
    let captured_track = project.track(&track_id).map_err(error_text)?;
    let profile_input_fingerprint = project
        .track_profile_input_fingerprint(&track_id, &device_ids)
        .map_err(error_text)?;
    let now = chrono::Utc::now();
    let effective_threads = worker_threads.unwrap_or(1).clamp(1, 256);
    let mut job = BackgroundJob {
        id: Uuid::new_v4().to_string(),
        operation: "trackEvidenceProfile".into(),
        device_id: "org.dgw.builtin.track-profiler".into(),
        track_id: track_id.clone(),
        status: BackgroundJobStatus::Queued,
        progress: 0,
        stage: "queued".into(),
        message: "Waiting for the background compute slot".into(),
        worker_threads: effective_threads,
        request: serde_json::json!({
            "stateId": &captured_track.head_state_id,
            "bypassedEditIds": &captured_track.bypassed_edit_ids,
            "deviceIds": &device_ids,
            "profileInputFingerprint": &profile_input_fingerprint,
        }),
        result: None,
        error: None,
        created_at: now,
        updated_at: now,
    };
    project.save_background_job(&job).map_err(error_text)?;

    let returned_job = job.clone();
    let evaluation = Arc::clone(&state.evaluation);
    let compute_pool = Arc::clone(&state.compute_pool);
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

        let mut last_reported = BTreeMap::<String, usize>::new();
        let mut device_progress = BTreeMap::<String, (usize, usize)>::new();
        let job_id = job.id.clone();
        let outcome = dgw_core::profile_track_parallel_with_threads(
            &compute_pool,
            &evaluation,
            &project,
            &track_id,
            &device_ids,
            job.worker_threads,
            |device_id, processed, total| {
                if job_was_cancelled(&cancelled_jobs, &job_id) {
                    return Err(dgw_core::DgwError::Tool("__cancelled__".into()));
                }
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
                update_job(
                    &project,
                    &mut job,
                    BackgroundJobStatus::Running,
                    progress,
                    "evidence",
                    message,
                )
                .map_err(dgw_core::DgwError::Tool)
            },
        )
        .map_err(error_text)
        .map_err(|error| {
            if error.contains("__cancelled__") {
                "__cancelled__".into()
            } else {
                error
            }
        });

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
        CONSEQUENCE_DEVICE_ID => "Variant Consequences",
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
    let started_at = chrono::Utc::now();
    let project = Project::open(project_path).map_err(error_text)?;
    let input_state_id = project.track(&track_id).map_err(error_text)?.head_state_id;
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
        .collect::<Vec<_>>();
    save_completed_device_run(
        &project,
        "org.dgw.builtin.mutation-generator",
        "mutationGenerator",
        &track_id,
        &input_state_id,
        serde_json::json!({"selectedVariants": &request.selected_variants}),
        serde_json::to_value(&request).map_err(error_text)?,
        serde_json::json!({
            "selectedPositions": plan.selected_positions,
            "randomizedPositions": plan.randomized_positions,
            "transitionPositions": plan.transition_positions,
            "transversionPositions": plan.transversion_positions,
            "generatedEdits": plan.generated_edits,
            "excludedPositions": plan.exclusions.len(),
            "noOpReason": &plan.no_op_reason,
            "limitation": &plan.limitation,
        }),
        generated_edit_ids.clone(),
        started_at,
    )?;
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
    match track_id {
        Some(track_id) => project
            .apply_allele_edit_at_head(&track_id, &parent_state_id, haplotype, edit, note)
            .map_err(error_text),
        None => {
            if let EditKind::SetAllele {
                key,
                source_key,
                unphased_slot,
            } = &edit
            {
                let normalized = normalize_variant(&project.manifest().resource_bundle, key)
                    .map_err(error_text)?;
                edit = EditKind::SetAllele {
                    key: normalized,
                    source_key: source_key.clone(),
                    unphased_slot: *unphased_slot,
                };
            }
            project
                .apply_edit(&parent_state_id, haplotype, edit, note, &bypassed_edit_ids)
                .map_err(error_text)
        }
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
fn suggested_development_bundles() -> Result<Vec<ResourceBundle>, String> {
    [
        include_str!("../../config/local-hs37d5.development.json"),
        include_str!("../../config/local-hg38.development.json"),
    ]
    .into_iter()
    .map(|contents| serde_json::from_str(contents).map_err(error_text))
    .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            evaluation: Arc::new(EvaluationService::new()),
            compute_pool: Arc::new(LocalComputePool::new()),
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
            project_resource_health,
            load_workstation_session,
            save_workstation_session,
            save_project_copy,
            focus_region,
            search_genes,
            export_focus_fasta,
            track_deck,
            variant_page,
            variant_contigs,
            variant_navigation_bins,
            variant_density,
            resolve_variant_selection,
            transport_target,
            save_workspace,
            select_track,
            duplicate_track,
            rename_track,
            delete_track,
            track_profile_input_fingerprint,
            consolidate_track,
            start_optimizer_job,
            preview_randomizer,
            start_randomizer_preview_job,
            start_track_morph_preview_job,
            background_job,
            list_background_jobs,
            list_device_runs,
            delete_finished_background_jobs,
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
            suggested_development_bundles
        ])
        .run(tauri::generate_context!())
        .expect("error while running DGW");
}

#[cfg(test)]
mod tests {
    use super::*;
    use dgw_core::{RandomizerProposal, SubstitutionPattern, VariantKey};

    #[test]
    fn bulk_optimizer_generates_one_three_alt_set_per_exact_locus() {
        let first = VariantKey {
            assembly: "GRCh37".into(),
            contig: "1".into(),
            position: 100,
            reference: "A".into(),
            alternate: "C".into(),
        };
        let second_alt = VariantKey {
            alternate: "G".into(),
            ..first.clone()
        };
        let candidates = optimizer_candidate_variants(&[first, second_alt]);
        assert_eq!(candidates.len(), 3);
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.alternate.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["C", "G", "T"])
        );
    }

    #[test]
    fn batch_signal_preserves_optimizer_impact_and_clinvar_guard_fields() {
        let evidence = evidence_from_batch_signal(
            "ClinVar test",
            &BatchEvidenceSignal {
                status: EvidenceStatus::Found,
                exact_match_count: 1,
                impact_signal: Some(1.0),
                impact_label: Some("HIGH".into()),
                clinvar_classification: Some("Likely_pathogenic".into()),
                no_transcript_feature: false,
            },
        );
        assert_eq!(
            evidence.records[0].get("impact").map(String::as_str),
            Some("HIGH")
        );
        assert_eq!(
            evidence.records[0].get("CLNSIG").map(String::as_str),
            Some("Likely_pathogenic")
        );
    }

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
                        unphased_slot: None,
                    },
                }
            })
            .collect();
        let preview = dgw_core::compact_randomizer_preview(&RandomizerPlan {
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
        assert_eq!(
            preview.changes.len(),
            dgw_core::RANDOMIZER_PREVIEW_CHANGE_LIMIT
        );
        assert_eq!(preview.randomized_positions, 250);
    }
}
