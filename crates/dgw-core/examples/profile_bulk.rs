use dgw_core::{
    plan_randomizer, Project, RandomizerRequest, SubstitutionPattern, VariantSelection,
};
use std::path::PathBuf;
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let project_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: profile_bulk PROJECT.dgw")?;
    let started = Instant::now();
    let project = Project::open(project_path)?;
    let workspace = project.workspace()?;
    println!("open\t{:?}", started.elapsed());

    let stage = Instant::now();
    let resolution = project.resolve_selection(
        &VariantSelection::AllTrack {
            track_id: workspace.active_track_id.clone(),
            exclusions: Vec::new(),
        },
        50_000,
    )?;
    println!(
        "resolve\t{:?}\t{} variants\ttruncated={}",
        stage.elapsed(),
        resolution.variants.len(),
        resolution.truncated
    );

    let stage = Instant::now();
    let effective = project
        .effective_variants_for_track_at_loci(&workspace.active_track_id, &resolution.variants)?;
    println!(
        "effective\t{:?}\t{} variants",
        stage.elapsed(),
        effective.len()
    );

    let stage = Instant::now();
    let plan = plan_randomizer(
        &effective,
        &RandomizerRequest {
            selected_variants: resolution.variants,
            amount: 100,
            seed: 1,
            substitution_pattern: SubstitutionPattern::Uniform,
            transition_probability: 67,
        },
    )?;
    println!(
        "plan\t{:?}\t{} positions\t{} edits",
        stage.elapsed(),
        plan.randomized_positions,
        plan.generated_edits
    );
    println!("total\t{:?}", started.elapsed());
    Ok(())
}
