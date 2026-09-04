use dgw_core::evaluation::normalize_variant;
use dgw_core::{CreateProjectRequest, EditKind, Haplotype, Project, ResourceBundle, VariantKey};
use std::env;
use std::fs::File;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let source_vcf = PathBuf::from(
        args.next()
            .ok_or("usage: multi_edit_smoke VCF SAMPLE PROJECT_DIR [BUNDLE_JSON]")?,
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
        name: "Five-mutation integration smoke".into(),
        source_vcf_path: source_vcf,
        selected_sample: sample,
        resource_bundle: bundle,
    })?;
    let snapshot = project.snapshot()?;
    let track_id = snapshot.active_track.id.clone();

    for (index, variant) in snapshot.variants.iter().take(5).enumerate() {
        let alternate = ["A", "C", "G", "T"]
            .into_iter()
            .find(|base| *base != variant.key.reference && *base != variant.key.alternate)
            .ok_or("no replacement SNV available")?;
        let key = normalize_variant(
            &snapshot.manifest.resource_bundle,
            &VariantKey {
                alternate: alternate.into(),
                ..variant.key.clone()
            },
        )?;
        let haplotype = if variant.unphased_alt {
            Haplotype::Unphased
        } else if variant.haplotype1_alt {
            Haplotype::One
        } else {
            Haplotype::Two
        };
        let state = project.apply_edit_to_track(
            &track_id,
            haplotype,
            EditKind::SetAllele {
                key,
                source_key: Some(variant.key.clone()),
                unphased_slot: variant.unphased_slot,
            },
            Some(format!("smoke mutation {}", index + 1)),
        )?;
        println!(
            "mutation={} position={} state={}",
            index + 1,
            variant.key.position,
            &state.id[..8]
        );
    }

    let edits = project.edits_for_track(&track_id)?;
    let effective = project.effective_variants_for_track(&track_id)?;
    println!(
        "stored_edits={} effective_variants={}",
        edits.len(),
        effective.len()
    );
    if edits.len() != 5 {
        return Err(format!("expected 5 stored edits, observed {}", edits.len()).into());
    }
    Ok(())
}
