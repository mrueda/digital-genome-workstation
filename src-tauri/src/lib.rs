use dgw_core::evaluation::normalize_variant;
use dgw_core::{
    built_in_device_manifests, inspect_vcf, plan_optimizer, plan_randomizer,
    validate_resource_bundle, CreateProjectRequest, DeviceManifest, EditKind, EditOperation,
    EffectiveVariant, EvaluationResult, EvaluationService, EvidenceResult, FocusContext,
    FocusFastaExport, FocusView, GenomeState, GenomeTrack, Haplotype, OptimizerPlan,
    OptimizerRequest, Project, ProjectSnapshot, RandomizerPlan, RandomizerRequest, ResourceBundle,
    VcfInspection, WorkspaceSnapshot,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

struct AppState {
    evaluation: Arc<EvaluationService>,
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
fn inspect_vcf_file(path: PathBuf, assembly: Option<String>) -> Result<VcfInspection, String> {
    inspect_vcf(path, assembly.as_deref().unwrap_or("b37")).map_err(error_text)
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
fn create_project(request: CreateProjectRequest) -> Result<ProjectSnapshot, String> {
    Project::create(request)
        .and_then(|project| project.snapshot())
        .map_err(error_text)
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
fn track_deck(project_path: PathBuf) -> Result<Vec<GenomeTrackLane>, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    project
        .list_tracks()
        .map_err(error_text)?
        .into_iter()
        .map(|track| {
            let edits = project.edits_for_track(&track.id).map_err(error_text)?;
            let variants = project
                .effective_variants_for_track(&track.id)
                .map_err(error_text)?;
            Ok(GenomeTrackLane {
                track,
                edits,
                variants,
            })
        })
        .collect()
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
    project_path: PathBuf,
    track_id: String,
    focus: FocusContext,
    request: OptimizerRequest,
) -> Result<OptimizerRunResult, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let source = project
        .effective_variants(&project.manifest().root_state_id, &[])
        .map_err(error_text)?;
    let current = project
        .effective_variants_for_track(&track_id)
        .map_err(error_text)?;
    let plan = plan_optimizer(&current, &source, &focus, &request).map_err(error_text)?;
    let mut generated_edit_ids = Vec::with_capacity(plan.proposals.len());
    for proposal in &plan.proposals {
        let state = project
            .apply_edit_to_track(
                &track_id,
                proposal.haplotype,
                proposal.edit.clone(),
                Some(format!(
                    "Genome Optimizer · {:?} {:?} · additive per-allele score",
                    request.direction, request.objective
                )),
            )
            .map_err(error_text)?;
        if let Some(edit_id) = state.edit_id {
            generated_edit_ids.push(edit_id);
        }
    }
    let snapshot = project.snapshot().map_err(error_text)?;
    Ok(OptimizerRunResult {
        plan,
        generated_edit_ids,
        snapshot,
    })
}

#[tauri::command]
fn preview_randomizer(
    project_path: PathBuf,
    track_id: String,
    request: RandomizerRequest,
) -> Result<RandomizerPlan, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let current = project
        .effective_variants_for_track(&track_id)
        .map_err(error_text)?;
    plan_randomizer(&current, &request).map_err(error_text)
}

#[tauri::command]
fn run_randomizer(
    project_path: PathBuf,
    track_id: String,
    request: RandomizerRequest,
) -> Result<RandomizerRunResult, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let current = project
        .effective_variants_for_track(&track_id)
        .map_err(error_text)?;
    let plan = plan_randomizer(&current, &request).map_err(error_text)?;
    let mut generated_edit_ids = Vec::with_capacity(plan.proposals.len());
    for proposal in &plan.proposals {
        let state = project
            .apply_edit_to_track(
                &track_id,
                proposal.haplotype,
                proposal.edit.clone(),
                Some(format!(
                    "Allele Randomizer · seed {} · amount {}%",
                    request.seed, request.amount
                )),
            )
            .map_err(error_text)?;
        if let Some(edit_id) = state.edit_id {
            generated_edit_ids.push(edit_id);
        }
    }
    let snapshot = project.snapshot().map_err(error_text)?;
    Ok(RandomizerRunResult {
        plan,
        generated_edit_ids,
        snapshot,
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
        })
        .invoke_handler(tauri::generate_handler![
            inspect_vcf_file,
            validate_bundle,
            device_catalog,
            create_project,
            open_project,
            focus_region,
            export_focus_fasta,
            track_deck,
            save_workspace,
            select_track,
            duplicate_track,
            rename_track,
            delete_track,
            consolidate_track,
            preview_randomizer,
            run_randomizer,
            run_optimizer,
            set_track_edit_bypass,
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
