use dgw_core::{
    inspect_vcf, CreateProjectRequest, EditKind, EvaluationService, FocusContext, Haplotype,
    Project, ResourceBundle,
};
use std::env;
use std::fs::File;
use std::path::PathBuf;

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
        project_path,
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
    if let Some(variant) = snapshot.variants.first() {
        let context = FocusContext {
            contig: variant.key.contig.clone(),
            start: variant.key.position.saturating_sub(30).max(1),
            end: variant.key.position + 30,
        };
        let focus = project.focus_view(context.clone())?;
        println!(
            "focus={} reference_bases={} variants={}",
            focus.context.contig,
            focus
                .reference_sequence
                .as_deref()
                .map(str::len)
                .unwrap_or(0),
            focus.variants.len()
        );
        let fasta = project.export_focus_fasta(
            &snapshot.active_track.id,
            context,
            project.root().join("exports/local-smoke.fa"),
        )?;
        println!(
            "fasta={} records={} masked_unphased={}",
            fasta.fasta_path.display(),
            fasta.sequence_records,
            fasta.masked_unphased_alleles
        );
        let result = EvaluationService::new().evaluate(&project, &variant.key)?;
        println!(
            "evaluation={} snpeff={:?} dbnsfp={:?} clinvar={:?} cosmic={:?}",
            variant.key.display(),
            result.snpeff.status,
            result.dbnsfp.status,
            result.clinvar.status,
            result.cosmic.status
        );
        let haplotype = if variant.haplotype1_alt {
            Haplotype::One
        } else if variant.haplotype2_alt {
            Haplotype::Two
        } else {
            Haplotype::Unphased
        };
        let edited_state = project.apply_edit(
            &snapshot.workspace.current_state_id,
            haplotype,
            EditKind::RestoreReference {
                source_key: variant.key.clone(),
            },
            Some("local integration smoke restore".into()),
            &[],
        )?;
        let after_restore = project.effective_variants(&edited_state.id, &[])?;
        let bypassed = project
            .effective_variants(&edited_state.id, &[edited_state.edit_id.clone().unwrap()])?;
        println!(
            "restore_state={} effective_variants={} bypassed_variants={}",
            &edited_state.id[..8],
            after_restore.len(),
            bypassed.len()
        );
        let rendered = project.render_state(
            &edited_state.id,
            &[],
            project.root().join("exports/local-smoke.vcf.gz"),
        )?;
        let rendered_inspection = inspect_vcf(&rendered, "b37")?;
        println!(
            "render={} records={} sample={}",
            rendered.display(),
            rendered_inspection.record_count,
            rendered_inspection
                .samples
                .first()
                .map(String::as_str)
                .unwrap_or("missing")
        );
    }
    Ok(())
}
