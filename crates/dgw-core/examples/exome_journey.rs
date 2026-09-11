//! Real-resource acceptance journey. All outputs go into a NEW disposable directory.
use dgw_core::{
    plan_randomizer, prediction_comparison, BackgroundJob, BackgroundJobStatus,
    CompoundMutationChange, CreateProjectRequest, EffectiveVariant, EvaluationService, Project,
    RandomizerRequest, ResourceBundle, SubstitutionPattern, CONSEQUENCE_DEVICE_ID,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::File, path::PathBuf, process::Command, time::Instant};

fn check_vcf(
    project: &Project,
    path: &std::path::Path,
    expected: &[EffectiveVariant],
) -> Result<(), Box<dyn std::error::Error>> {
    // Read the exported file independently of DGW's VCF reader/renderer.
    let samples = Command::new(&project.manifest().resource_bundle.bcftools_path)
        .args(["query", "-l"])
        .arg(path)
        .output()?;
    assert!(
        samples.status.success(),
        "cannot read exported sample header"
    );
    assert_eq!(
        String::from_utf8(samples.stdout)?.trim(),
        project.manifest().selected_sample
    );
    let output = Command::new(&project.manifest().resource_bundle.bcftools_path)
        .args(["query", "-f", "%CHROM\t%POS\t%REF\t%ALT[\t%GT]\n"])
        .arg(path)
        .output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
    }
    let key = |v: &EffectiveVariant| {
        format!(
            "{}\t{}\t{}\t{}",
            v.key.contig, v.key.position, v.key.reference, v.key.alternate
        )
    };
    let mut remaining: BTreeMap<_, _> = expected.iter().map(|v| (key(v), v)).collect();
    assert_eq!(
        remaining.len(),
        expected.len(),
        "duplicate effective allele keys"
    );
    for row in String::from_utf8(output.stdout)?.lines() {
        let (allele, gt) = row.rsplit_once('\t').ok_or("missing GT in exported VCF")?;
        let variant = remaining
            .remove(allele)
            .ok_or_else(|| format!("unexpected/duplicate exported allele: {allele}"))?;
        let dosage = gt.split(['|', '/']).filter(|part| *part == "1").count();
        assert_eq!(
            dosage,
            usize::from(variant.haplotype1_alt)
                + usize::from(variant.haplotype2_alt)
                + usize::from(variant.unphased_alt),
            "exported ALT dosage at {allele}"
        );
        if variant.unphased_alt {
            assert!(
                matches!(gt, "0/1" | "1/0"),
                "unphased call changed phase at {allele}"
            );
            if let Some(slot) = variant.unphased_slot {
                assert_eq!(
                    gt.split('/').position(|part| part == "1"),
                    Some(usize::from(slot - 1)),
                    "unphased slot at {allele}"
                );
            }
        } else {
            let copies: Vec<_> = gt.split('|').collect();
            assert_eq!(copies.len(), 2, "phased call lost phase at {allele}");
            assert_eq!(copies[0] == "1", variant.haplotype1_alt);
            assert_eq!(copies[1] == "1", variant.haplotype2_alt);
        }
    }
    assert!(
        remaining.is_empty(),
        "some effective alleles are absent from export"
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err("usage: exome_journey VCF SAMPLE NEW_OUTPUT_DIRECTORY BUNDLE_JSON".into());
    }
    let started = Instant::now();
    let source = PathBuf::from(&args[0]).canonicalize()?;
    let original_hash = Sha256::digest(std::fs::read(&source)?);
    let output = PathBuf::from(&args[2]);
    std::fs::create_dir(&output)?; // Refuse existing directories; never touch existing projects.
    let output = output.canonicalize()?;
    let bundle: ResourceBundle = serde_json::from_reader(File::open(&args[3])?)?;
    println!("1/6 Importing into {}", output.display());
    let project = Project::create(CreateProjectRequest {
        project_path: output.join("experiment.dgw"),
        name: "Exome journey acceptance".into(),
        source_vcf_path: source.clone(),
        selected_sample: args[1].clone(),
        resource_bundle: bundle,
    })?;
    let source_track = project
        .list_tracks()?
        .into_iter()
        .find(|t| t.read_only)
        .ok_or("missing protected source track")?;
    let original = project.effective_variants_for_track(&source_track.id)?;
    let contigs: std::collections::BTreeSet<_> = original.iter().map(|v| &v.key.contig).collect();
    println!(
        "imported_alleles={} contigs={}",
        original.len(),
        contigs.len()
    );
    assert!(contigs.len() > 1, "use a multi-contig fixture");
    let candidate = project.duplicate_track(&source_track.id, "Randomized candidate")?;
    println!("2/6 Randomizing all eligible positions (seed 42)");
    let plan = plan_randomizer(
        &original,
        &RandomizerRequest {
            selected_variants: original.iter().map(|v| v.key.clone()).collect(),
            amount: 100,
            seed: 42,
            substitution_pattern: SubstitutionPattern::Uniform,
            transition_probability: 67,
        },
    )?;
    assert!(plan.randomized_positions > 0);
    let changes: Vec<_> = plan
        .proposals
        .iter()
        .map(|p| CompoundMutationChange {
            haplotype: p.haplotype,
            edit: p.edit.clone(),
        })
        .collect();
    let layer = project.stage_compound_mutation_layer(
        &candidate.id,
        &candidate.head_state_id,
        "org.dgw.builtin.mutation-generator",
        plan.randomized_positions,
        &changes,
        Some("Acceptance journey".into()),
    )?;
    let edited = project.apply_compound_mutation_layer(&candidate.id, &layer.id)?;
    let expected = project.effective_variants_for_track(&candidate.id)?;
    assert_eq!(
        project.effective_variants_for_track(&source_track.id)?,
        original
    );
    println!(
        "changed_positions={} copy_edits={}",
        plan.randomized_positions,
        changes.len()
    );
    println!("3/6 Comparing source/current predictions");
    let ids = vec![CONSEQUENCE_DEVICE_ID.to_owned()];
    let id = uuid::Uuid::new_v4().to_string();
    let revision = project.track_comparison_revision(&candidate.id)?;
    let mut previous = String::new();
    let report = prediction_comparison::run(
        &project,
        &EvaluationService::new(),
        &candidate.id,
        &id,
        &revision,
        &ids,
        |percent, message| {
            if previous != message {
                println!("{percent}% {message}");
                previous = message.into();
            }
            Ok(())
        },
    )?;
    // The Randomizer counts selected ALT entries; comparison groups multiallelic
    // entries sharing contig/POS/REF into one locus.
    let changed_loci: std::collections::BTreeSet<_> = plan
        .proposals
        .iter()
        .map(|p| {
            (
                &p.source_variant.contig,
                p.source_variant.position,
                &p.source_variant.reference,
            )
        })
        .collect();
    assert_eq!(report.total, changed_loci.len() as u64);
    assert_eq!(
        report.counts.get("missing").copied().unwrap_or(0),
        0,
        "real consequence resources are required"
    );
    let now = chrono::Utc::now();
    let job = BackgroundJob {
        id: id.clone(),
        operation: "trackPredictionComparison".into(),
        device_id: CONSEQUENCE_DEVICE_ID.into(),
        track_id: candidate.id.clone(),
        status: BackgroundJobStatus::Completed,
        progress: 100,
        stage: "completed".into(),
        message: "Journey comparison".into(),
        worker_threads: 1,
        request: serde_json::json!({"stateId": edited.id, "deviceIds": ids, "revision": revision}),
        result: Some(serde_json::to_value(&report)?),
        error: None,
        created_at: now,
        updated_at: now,
    };
    project.save_background_job(&job)?;
    project.persist_terminal_device_run(&job)?;
    let session = serde_json::json!({"schemaVersion": 1, "selectedDeviceId": "org.dgw.builtin.mutation-generator", "appliedDevicesByTrack": { &candidate.id: &ids }});
    project.save_workstation_session(&session)?;
    println!("4/6 Saving a copy and reopening it");
    let saved = project.save_copy(output.join("saved.dgw"))?;
    drop(saved);
    drop(project);
    let saved = Project::open(output.join("saved.dgw"))?;
    assert_eq!(saved.active_track()?.id, candidate.id);
    assert_eq!(saved.workstation_session()?, Some(session));
    assert_eq!(saved.effective_variants_for_track(&candidate.id)?, expected);
    assert_eq!(
        saved.effective_variants_for_track(&source_track.id)?,
        original
    );
    assert_eq!(saved.background_job(&id)?.result, job.result);
    let mut inspected = 0;
    for (outcome, count) in &report.counts {
        for offset in (0..*count).step_by(200) {
            let page = prediction_comparison::page(&saved, &id, &ids, Some(outcome), offset)?;
            assert!(!page.stale);
            assert_eq!(page.total, *count);
            assert!(!page.rows.is_empty() && page.rows.len() <= 200);
            inspected += page.rows.len() as u64;
        }
    }
    assert_eq!(inspected, report.total);
    println!(
        "saved_predictions={:?} inspected_rows={inspected}",
        report.counts
    );
    println!("5/6 Exporting and independently checking every allele/genotype");
    let track = saved.track(&candidate.id)?;
    let exported = saved.export_track_vcf_at_head(
        &candidate.id,
        &track.head_state_id,
        &track.bypassed_edit_ids,
        output.join("candidate.vcf.gz"),
    )?;
    check_vcf(&saved, &exported.vcf_path, &expected)?;
    for path in [
        &exported.index_path,
        &exported.evidence_path,
        &exported.device_runs_path,
        &exported.provenance_path,
    ] {
        assert!(path.is_file());
    }
    assert!(
        saved
            .export_track_vcf_at_head(
                &candidate.id,
                &track.head_state_id,
                &track.bypassed_edit_ids,
                &exported.vcf_path
            )
            .is_err(),
        "export overwrite must be rejected"
    );
    println!("6/6 Bypassing layer: old report must become stale");
    saved.toggle_track_edit_bypass(
        &candidate.id,
        edited
            .edit_id
            .as_deref()
            .ok_or("missing compound edit ID")?,
        true,
    )?;
    assert!(prediction_comparison::page(&saved, &id, &ids, None, 0)?.stale);
    saved.toggle_track_edit_bypass(&candidate.id, edited.edit_id.as_deref().unwrap(), false)?;
    assert!(!prediction_comparison::page(&saved, &id, &ids, None, 0)?.stale);
    assert_eq!(
        Sha256::digest(std::fs::read(&source)?),
        original_hash,
        "input VCF was modified"
    );
    println!(
        "journey=passed export_alleles={} elapsed_seconds={:.3} output={}",
        expected.len(),
        started.elapsed().as_secs_f64(),
        output.display()
    );
    Ok(())
}
