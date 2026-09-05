use chrono::Utc;
use dgw_core::{
    inspect_vcf, plan_randomizer, plan_saturation_optimizer, profile_track, BackgroundJob,
    BackgroundJobStatus, CompoundMutationChange, CreateProjectRequest, EvaluationService,
    FocusContext, OptimizerDirection, OptimizerMode, OptimizerObjective, OptimizerRequest,
    OptimizerWeights, Project, RandomizerRequest, ResourceBundle, SubstitutionPattern,
    TrackEvidenceProfileResult, VariantSelection, CONSEQUENCE_DEVICE_ID,
};
use std::collections::BTreeSet;
use std::env;
use std::fs::File;
use std::path::PathBuf;

const EVIDENCE_DEVICES: [&str; 4] = [
    CONSEQUENCE_DEVICE_ID,
    "org.dgw.builtin.dbnsfp",
    "org.dgw.builtin.clinvar",
    "org.dgw.builtin.cosmic",
];

fn require(condition: bool, message: impl Into<String>) -> Result<(), Box<dyn std::error::Error>> {
    if condition {
        Ok(())
    } else {
        Err(message.into().into())
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let source_vcf = PathBuf::from(
        args.next()
            .ok_or("usage: device_acceptance VCF SAMPLE PROJECT_DIR BUNDLE_JSON")?,
    );
    let sample = args.next().ok_or("missing sample")?;
    let project_path = PathBuf::from(args.next().ok_or("missing project directory")?);
    let bundle_path = PathBuf::from(args.next().ok_or("missing resource bundle JSON")?);
    let bundle: ResourceBundle = serde_json::from_reader(File::open(bundle_path)?)?;
    let project = Project::create(CreateProjectRequest {
        project_path: project_path.clone(),
        name: "Device acceptance".into(),
        source_vcf_path: source_vcf,
        selected_sample: sample,
        resource_bundle: bundle,
    })?;
    let initial = project.snapshot()?;
    let base_track = initial.active_track.clone();
    let resolution = project.resolve_selection(
        &VariantSelection::AllTrack {
            track_id: base_track.id.clone(),
            exclusions: Vec::new(),
        },
        100_000,
    )?;
    require(!resolution.truncated, "all-track selection was truncated")?;
    require(
        resolution.variants.len() >= 5,
        "device acceptance requires at least five selected SNVs",
    )?;
    println!(
        "selection={} assembly={} contigs={}",
        resolution.variants.len(),
        initial.manifest.assembly,
        resolution
            .variants
            .iter()
            .map(|variant| variant.contig.as_str())
            .collect::<BTreeSet<_>>()
            .len()
    );

    let evaluation = EvaluationService::new();
    let randomizer_track = project.duplicate_track(&base_track.id, "Randomizer acceptance")?;
    let randomizer_current = project.effective_variants_for_track(&randomizer_track.id)?;
    let randomizer_request = RandomizerRequest {
        selected_variants: resolution.variants.clone(),
        amount: 100,
        seed: 42,
        substitution_pattern: SubstitutionPattern::Uniform,
        transition_probability: 67,
    };
    let randomizer_plan = plan_randomizer(&randomizer_current, &randomizer_request)?;
    require(
        randomizer_plan.randomized_positions > 0 && !randomizer_plan.proposals.is_empty(),
        "Randomizer did not produce an eligible deterministic change",
    )?;
    let randomizer_changes: Vec<_> = randomizer_plan
        .proposals
        .iter()
        .map(|proposal| CompoundMutationChange {
            haplotype: proposal.haplotype,
            edit: proposal.edit.clone(),
        })
        .collect();
    let randomizer_layer = project.stage_compound_mutation_layer(
        &randomizer_track.id,
        &randomizer_track.head_state_id,
        "org.dgw.builtin.mutation-generator",
        randomizer_plan.randomized_positions,
        &randomizer_changes,
        Some("Device acceptance · deterministic randomization".into()),
    )?;
    project.apply_compound_mutation_layer(&randomizer_track.id, &randomizer_layer.id)?;
    let randomizer_mutations = project.active_track_mutations(&randomizer_track.id)?;
    require(
        randomizer_mutations.len() == randomizer_changes.len(),
        "Randomizer compound layer did not expand to the planned allele-copy changes",
    )?;
    println!(
        "randomizer={} positions={} allele_changes={} layer=ok",
        randomizer_request.substitution_pattern.label(),
        randomizer_plan.randomized_positions,
        randomizer_changes.len()
    );

    let device_ids: Vec<_> = EVIDENCE_DEVICES.iter().map(|id| (*id).to_owned()).collect();
    let profile = profile_track(
        &evaluation,
        &project,
        &randomizer_track.id,
        &device_ids,
        |_, _, _| Ok(()),
    )?;
    require(
        profile.active_mutations == randomizer_changes.len() as u32,
        "Track Profiler mutation count differs from the applied Randomizer layer",
    )?;
    require(
        profile.device_coverage.len() == EVIDENCE_DEVICES.len(),
        "Track Profiler did not run every active Evidence device",
    )?;
    require(
        profile
            .device_coverage
            .iter()
            .all(|coverage| coverage.unavailable == 0 && coverage.errors == 0),
        "Track Profiler reported unavailable resources or errors",
    )?;
    let normalized_delta = profile
        .impact_delta
        .map(|delta| delta / f64::from(profile.active_mutations));
    println!(
        "profile=ok mutations={} evaluated={} impact_delta={:?} normalized_delta={:?}",
        profile.active_mutations,
        profile.evaluated_mutations,
        profile.impact_delta,
        normalized_delta
    );

    let now = Utc::now();
    let profile_job = BackgroundJob {
        id: "device-acceptance-track-profile".into(),
        operation: "trackEvidenceProfile".into(),
        device_id: "org.dgw.builtin.track-profiler".into(),
        track_id: randomizer_track.id.clone(),
        status: BackgroundJobStatus::Completed,
        progress: 100,
        stage: "completed".into(),
        message: "Device acceptance profile completed".into(),
        worker_threads: 1,
        request: serde_json::json!({
            "deviceIds": &device_ids,
            "profileInputFingerprint": &profile.profile_input_fingerprint
        }),
        result: Some(serde_json::to_value(&profile)?),
        error: None,
        created_at: now,
        updated_at: now,
    };
    project.save_background_job(&profile_job)?;
    project.persist_terminal_device_run(&profile_job)?;
    let expected_run = project.device_run(&profile_job.id)?;

    let optimizer_track = project.duplicate_track(&base_track.id, "Saturation acceptance")?;
    let optimizer_current = project.effective_variants_for_track(&optimizer_track.id)?;
    let focus = FocusContext {
        contig: resolution.variants[0].contig.clone(),
        start: resolution.variants[0].position,
        end: resolution.variants[0].position,
    };
    let optimizer_request = |direction| OptimizerRequest {
        mode: OptimizerMode::Saturation,
        objective: OptimizerObjective::PredictedImpactBurden,
        direction,
        max_edits: resolution.variants.len() as u32,
        weights: OptimizerWeights {
            impact: 1.0,
            clinvar: 0.0,
            source_evidence: 0.0,
        },
        selected_variants: resolution.variants.clone(),
        evidence_device_ids: vec![
            CONSEQUENCE_DEVICE_ID.into(),
            "org.dgw.builtin.clinvar".into(),
        ],
    };
    let minimize_request = optimizer_request(OptimizerDirection::Minimize);
    let maximize_request = optimizer_request(OptimizerDirection::Maximize);
    let saturation_evidence =
        evaluation.evaluate_saturation_candidates(&project, &minimize_request)?;
    let saturation_positions = resolution
        .variants
        .iter()
        .filter(|variant| {
            variant.reference.len() == 1
                && variant.alternate.len() == 1
                && matches!(
                    variant.reference.as_bytes()[0].to_ascii_uppercase(),
                    b'A' | b'C' | b'G' | b'T'
                )
        })
        .count();
    require(
        saturation_evidence.len() == saturation_positions * 3,
        "Saturation did not evaluate three non-reference candidates per selected SNV",
    )?;
    let minimize = plan_saturation_optimizer(
        &optimizer_current,
        &focus,
        &minimize_request,
        &saturation_evidence,
    )?;
    let maximize = plan_saturation_optimizer(
        &optimizer_current,
        &focus,
        &maximize_request,
        &saturation_evidence,
    )?;
    let (chosen_request, chosen_plan) = if maximize.proposals.len() >= minimize.proposals.len() {
        (&maximize_request, &maximize)
    } else {
        (&minimize_request, &minimize)
    };
    require(
        !chosen_plan.proposals.is_empty(),
        "neither Saturation direction produced a strict improvement",
    )?;
    let optimizer_changes: Vec<_> = chosen_plan
        .proposals
        .iter()
        .map(|proposal| CompoundMutationChange {
            haplotype: proposal.haplotype,
            edit: proposal.edit.clone(),
        })
        .collect();
    let changed_positions = chosen_plan
        .proposals
        .iter()
        .map(|proposal| proposal.source_variant.stable_key())
        .collect::<BTreeSet<_>>()
        .len() as u32;
    let optimizer_layer = project.stage_compound_mutation_layer(
        &optimizer_track.id,
        &optimizer_track.head_state_id,
        "org.dgw.builtin.genome-optimizer",
        changed_positions,
        &optimizer_changes,
        Some(format!(
            "Device acceptance · Saturation {:?}",
            chosen_request.direction
        )),
    )?;
    project.apply_compound_mutation_layer(&optimizer_track.id, &optimizer_layer.id)?;
    println!(
        "saturation={:?} candidates={} changed_positions={} allele_changes={} score={:.3}->{:.3}",
        chosen_request.direction,
        saturation_evidence.len(),
        changed_positions,
        optimizer_changes.len(),
        chosen_plan.score_before,
        chosen_plan.score_after
    );

    let optimized_current = project.effective_variants_for_track(&optimizer_track.id)?;
    let repeated_keys: Vec<_> = optimized_current
        .iter()
        .filter(|variant| {
            resolution.variants.iter().any(|selected| {
                selected.contig == variant.key.contig
                    && selected.position == variant.key.position
                    && selected.reference == variant.key.reference
            })
        })
        .map(|variant| variant.key.clone())
        .collect();
    let mut repeated_request = chosen_request.clone();
    repeated_request.selected_variants = repeated_keys;
    let repeated_evidence =
        evaluation.evaluate_saturation_candidates(&project, &repeated_request)?;
    let repeated_plan = plan_saturation_optimizer(
        &optimized_current,
        &focus,
        &repeated_request,
        &repeated_evidence,
    )?;
    require(
        repeated_plan.proposals.is_empty() && repeated_plan.no_op_reason.is_some(),
        "repeating the same Saturation direction should report a no-op",
    )?;
    println!("saturation_repeat=no-op");

    let expected_optimizer_variants = project.effective_variants_for_track(&optimizer_track.id)?;
    let session = serde_json::json!({
        "schemaVersion": 1,
        "appliedDevicesByTrack": { &randomizer_track.id: &device_ids },
        "bypassedDevicesByTrack": { &randomizer_track.id: ["org.dgw.builtin.cosmic"] },
        "selectedDeviceId": "org.dgw.builtin.mutation-generator"
    });
    project.save_workstation_session(&session)?;
    let expected_tracks = project.list_tracks()?;
    drop(project);
    let reopened = Project::open(&project_path)?;
    require(
        reopened.list_tracks()? == expected_tracks,
        "track metadata changed after reopening",
    )?;
    require(
        reopened.workstation_session()? == Some(session.clone()),
        "rack session changed after reopening",
    )?;
    require(
        reopened.device_run(&profile_job.id)? == expected_run,
        "immutable run changed after reopening",
    )?;
    let copied = reopened.save_copy(project_path.with_extension("copy.dgw"))?;
    require(
        copied.workstation_session()? == Some(session),
        "rack session missing in Save Copy",
    )?;
    require(
        copied.device_run(&profile_job.id)? == expected_run,
        "run ledger missing in Save Copy",
    )?;
    require(
        copied.effective_variants_for_track(&optimizer_track.id)? == expected_optimizer_variants,
        "Save Copy changed effective alleles",
    )?;
    require(
        reopened.effective_variants_for_track(&optimizer_track.id)? == expected_optimizer_variants,
        "optimized effective alleles changed after reopening",
    )?;
    let persisted_job = reopened.background_job(&profile_job.id)?;
    require(
        persisted_job.status == BackgroundJobStatus::Completed,
        "completed Track Profiler job did not persist",
    )?;
    let persisted_profile: TrackEvidenceProfileResult = serde_json::from_value(
        persisted_job
            .result
            .ok_or("persisted Track Profiler job has no result")?,
    )?;
    require(
        persisted_profile == profile,
        "persisted Track Profiler result changed after reopening",
    )?;

    let export_track = reopened.track(&optimizer_track.id)?;
    let fasta = reopened.export_focus_fasta_at_head(
        &optimizer_track.id,
        &export_track.head_state_id,
        &export_track.bypassed_edit_ids,
        focus.clone(),
        project_path.with_extension("fa"),
    )?;
    require(
        fasta.sequence_records == 3 && fasta.fasta_path.is_file(),
        "guarded FASTA export failed",
    )?;
    let exported = reopened.export_track_vcf_at_head(
        &optimizer_track.id,
        &export_track.head_state_id,
        &export_track.bypassed_edit_ids,
        project_path.with_extension("vcf.gz"),
    )?;
    let provenance: serde_json::Value =
        serde_json::from_reader(File::open(&exported.provenance_path)?)?;
    require(
        provenance["evidenceSidecar"]["path"] == serde_json::to_value(&exported.evidence_path)?,
        "provenance refers to a temporary evidence path",
    )?;
    let rendered = exported.vcf_path;
    let inspection = inspect_vcf(&rendered, &initial.manifest.assembly)?;
    require(
        inspection.record_count == expected_optimizer_variants.len() as u64,
        "optimized VCF record count differs from the reopened track",
    )?;
    println!(
        "reopen=ok profile_job=ok export_records={} acceptance=passed",
        inspection.record_count
    );
    Ok(())
}
