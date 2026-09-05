use dgw_core::{
    inspect_vcf, CreateProjectRequest, EditKind, EvaluationService, EvidenceStatus, FocusContext,
    Haplotype, Project, ResourceBundle,
};
use std::env;
use std::fs::File;
use std::path::{Path, PathBuf};

fn require(condition: bool, message: impl Into<String>) -> Result<(), Box<dyn std::error::Error>> {
    if condition {
        Ok(())
    } else {
        Err(message.into().into())
    }
}

fn require_usable_evidence(
    source: &str,
    status: EvidenceStatus,
) -> Result<(), Box<dyn std::error::Error>> {
    require(
        matches!(status, EvidenceStatus::Found | EvidenceStatus::NoExactMatch),
        format!("{source} did not complete successfully: {status:?}"),
    )
}

fn companion_path(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", path.display()))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let source_vcf = PathBuf::from(
        args.next()
            .ok_or("usage: local_smoke VCF SAMPLE PROJECT_DIR [BUNDLE_JSON]")?,
    );
    let sample = args.next().ok_or("missing sample")?;
    let project_path = PathBuf::from(args.next().ok_or("missing project directory")?);
    let bundle_path = PathBuf::from(
        args.next()
            .unwrap_or_else(|| "config/local-hs37d5.development.json".into()),
    );
    let bundle: ResourceBundle = serde_json::from_reader(File::open(bundle_path)?)?;
    let project = Project::create(CreateProjectRequest {
        project_path: project_path.clone(),
        name: "Local integration smoke".into(),
        source_vcf_path: source_vcf,
        selected_sample: sample,
        resource_bundle: bundle,
    })?;
    let snapshot = project.snapshot()?;
    println!(
        "project={} states={} selected_variants={} warnings={}",
        snapshot.manifest.project_id,
        snapshot.states.len(),
        snapshot.variant_count,
        snapshot.warnings.len()
    );
    require(
        snapshot.variant_count > 0,
        "the selected sample has no variants",
    )?;
    let variant = snapshot
        .variants
        .first()
        .ok_or("the initial bounded snapshot contains no variant")?
        .clone();
    let context = FocusContext {
        contig: variant.key.contig.clone(),
        start: variant.key.position.saturating_sub(30).max(1),
        end: variant.key.position + 30,
    };
    let focus = project.focus_view(context.clone())?;
    let reference_bases = focus
        .reference_sequence
        .as_deref()
        .map(str::len)
        .unwrap_or(0);
    require(
        reference_bases == 61,
        format!("expected 61 reference bases, found {reference_bases}"),
    )?;
    require(
        focus.haplotype1_sequence.as_deref().map(str::len) == Some(61)
            && focus.haplotype2_sequence.as_deref().map(str::len) == Some(61),
        "both chromosome-copy sequences must be reconstructed",
    )?;
    println!(
        "focus={} reference_bases={} variants={}",
        focus.context.contig,
        reference_bases,
        focus.variants.len()
    );

    let evaluation = EvaluationService::new().evaluate(&project, &variant.key)?;
    require_usable_evidence(
        "Variant Consequences",
        evaluation.consequence.status.clone(),
    )?;
    require_usable_evidence("ClinVar", evaluation.clinvar.status.clone())?;
    require_usable_evidence("COSMIC", evaluation.cosmic.status.clone())?;
    println!(
        "evaluation={} consequences={:?} clinvar={:?} cosmic={:?}",
        variant.key.display(),
        evaluation.consequence.status,
        evaluation.clinvar.status,
        evaluation.cosmic.status
    );

    let candidate = project.duplicate_track(&snapshot.active_track.id, "Acceptance candidate")?;
    let before_edit = project.effective_variants_for_track(&candidate.id)?;
    let haplotype = if variant.haplotype1_alt {
        Haplotype::One
    } else if variant.haplotype2_alt {
        Haplotype::Two
    } else {
        Haplotype::Unphased
    };
    let edited_state = project.apply_edit_to_track(
        &candidate.id,
        haplotype,
        EditKind::RestoreReference {
            source_key: variant.key.clone(),
        },
        Some("real-stack acceptance restore".into()),
    )?;
    let after_edit = project.effective_variants_for_track(&candidate.id)?;
    require(
        before_edit != after_edit,
        "the candidate track did not change after applying the edit",
    )?;
    require(
        project.edits_for_track(&candidate.id)?.len() == 1,
        "the candidate track must contain exactly one edit",
    )?;
    let session = serde_json::json!({
        "schemaVersion": 1,
        "acceptance": {
            "activeTrackId": &candidate.id,
            "focusedVariant": &variant.key,
            "mode": "alleleRoll"
        }
    });
    project.save_workstation_session(&session)?;
    println!(
        "edit_track={} restore_state={} variants_before={} variants_after={}",
        candidate.name,
        &edited_state.id[..8],
        before_edit.len(),
        after_edit.len()
    );

    drop(project);
    let reopened = Project::open(&project_path)?;
    let reopened_active = reopened.active_track()?;
    require(
        reopened_active.id == candidate.id,
        "the active candidate track was not restored after reopening",
    )?;
    require(
        reopened_active.head_state_id == edited_state.id,
        "the candidate edit head was not restored after reopening",
    )?;
    require(
        reopened.workstation_session()?.as_ref() == Some(&session),
        "the workstation session was not restored after reopening",
    )?;
    require(
        reopened.effective_variants_for_track(&candidate.id)? == after_edit,
        "the effective candidate alleles changed after reopening",
    )?;
    let persisted_evaluation = reopened
        .cache_get(&evaluation.cache_key)?
        .ok_or("the combined exact-allele evidence cache is missing after reopening")?;
    require(
        persisted_evaluation == evaluation,
        "the persisted exact-allele evidence cache changed after reopening",
    )?;
    let reevaluated = EvaluationService::new().evaluate(&reopened, &variant.key)?;
    require(
        reevaluated.cache_key == evaluation.cache_key
            && reevaluated.consequence == evaluation.consequence
            && reevaluated.clinvar == evaluation.clinvar
            && reevaluated.cosmic == evaluation.cosmic,
        "re-evaluation after reopening did not reuse equivalent device evidence",
    )?;
    println!(
        "reopen=ok tracks={} session=ok evidence_cache=ok",
        reopened.list_tracks()?.len()
    );

    let fasta = reopened.export_focus_fasta(
        &candidate.id,
        context,
        reopened.root().join("exports/local-smoke.fa"),
    )?;
    require(
        fasta.fasta_path.is_file(),
        "regional FASTA export is missing",
    )?;
    require(
        fasta.sequence_records == 3,
        "regional FASTA must contain three records",
    )?;
    if let Some(path) = &fasta.uncertainty_path {
        require(path.is_file(), "the FASTA uncertainty sidecar is missing")?;
    }
    println!(
        "fasta={} records={} masked_unphased={}",
        fasta.fasta_path.display(),
        fasta.sequence_records,
        fasta.masked_unphased_alleles
    );

    let rendered = reopened.render_track(
        &candidate.id,
        reopened.root().join("exports/local-smoke.vcf.gz"),
    )?;
    let rendered_inspection = inspect_vcf(&rendered, &snapshot.manifest.assembly)?;
    require(
        rendered_inspection.samples == vec![snapshot.manifest.selected_sample.clone()],
        "rendered VCF sample does not match the selected project sample",
    )?;
    require(
        rendered_inspection.record_count == after_edit.len() as u64,
        format!(
            "rendered VCF has {} records but the track has {} effective alleles",
            rendered_inspection.record_count,
            after_edit.len()
        ),
    )?;
    for (label, path) in [
        ("CSI index", companion_path(&rendered, ".csi")),
        (
            "evidence sidecar",
            companion_path(&rendered, ".evidence.json.gz"),
        ),
        (
            "device-run sidecar",
            companion_path(&rendered, ".device-runs.json.gz"),
        ),
        (
            "provenance sidecar",
            companion_path(&rendered, ".provenance.json"),
        ),
    ] {
        require(path.is_file(), format!("rendered VCF {label} is missing"))?;
    }
    println!(
        "render={} records={} sample={} sidecars=ok",
        rendered.display(),
        rendered_inspection.record_count,
        rendered_inspection
            .samples
            .first()
            .map(String::as_str)
            .unwrap_or("missing")
    );
    println!("acceptance=passed assembly={}", snapshot.manifest.assembly);
    Ok(())
}
