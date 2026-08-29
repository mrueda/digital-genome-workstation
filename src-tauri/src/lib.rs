use dgw_core::evaluation::normalize_variant;
use dgw_core::{
    built_in_device_manifests, inspect_vcf, plan_optimizer_with_evidence, plan_randomizer,
    validate_resource_bundle, CreateProjectRequest, DeviceManifest, EditKind, EditOperation,
    EffectiveVariant, EvaluationResult, EvaluationService, EvidenceResult, EvidenceStatus,
    FocusContext, FocusFastaExport, FocusView, GenomeState, GenomeTrack, Haplotype,
    OptimizerAlleleEvidenceInput, OptimizerDirection, OptimizerMode, OptimizerObjective,
    OptimizerPlan, OptimizerRequest, Project, ProjectSnapshot, RandomizerPlan, RandomizerRequest,
    ResourceBundle, SaturationAlleleInput, SelectionResolution, VariantDensity, VariantPage,
    VariantSelection, VcfInspection, WorkspaceSnapshot,
};
use serde::Serialize;
use std::collections::BTreeMap;
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
fn preview_randomizer(
    project_path: PathBuf,
    track_id: String,
    request: RandomizerRequest,
) -> Result<RandomizerPlan, String> {
    let project = Project::open(project_path).map_err(error_text)?;
    let current = project
        .effective_variants_for_track_at_loci(&track_id, &request.selected_variants)
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
        .effective_variants_for_track_at_loci(&track_id, &request.selected_variants)
        .map_err(error_text)?;
    let plan = plan_randomizer(&current, &request).map_err(error_text)?;
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
            variant_density,
            resolve_variant_selection,
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
