use dgw_core::{
    plan_randomizer, profile_track, profile_track_parallel_with_threads, CompoundMutationChange,
    CreateProjectRequest, EvaluationService, LocalComputePool, Project, RandomizerRequest,
    ResourceBundle, SubstitutionPattern, TrackEvidenceProfileResult, VariantSelection,
    CONSEQUENCE_DEVICE_ID,
};
use std::collections::BTreeMap;
use std::env;
use std::fs::File;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const DEVICES: [&str; 4] = [
    CONSEQUENCE_DEVICE_ID,
    "org.dgw.builtin.dbnsfp",
    "org.dgw.builtin.clinvar",
    "org.dgw.builtin.cosmic",
];

fn run_profile(
    pool: &LocalComputePool,
    evaluation: &EvaluationService,
    project: &Project,
    track_id: &str,
    threads: u16,
) -> Result<TrackEvidenceProfileResult, String> {
    let device_ids: Vec<_> = DEVICES.iter().map(|device| (*device).to_owned()).collect();
    profile_track_parallel_with_threads(
        pool,
        evaluation,
        project,
        track_id,
        &device_ids,
        threads,
        |_, _, _| Ok(()),
    )
    .map_err(|error| error.to_string())
}

fn median(samples: &mut [Duration]) -> Duration {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

fn benchmark_track(project: &Project) -> Result<dgw_core::GenomeTrack, Box<dyn std::error::Error>> {
    project
        .snapshot()?
        .tracks
        .into_iter()
        .find(|track| track.name == "Parallel benchmark")
        .or_else(|| {
            project
                .snapshot()
                .ok()?
                .tracks
                .into_iter()
                .find(|track| !track.read_only && !track.archived)
        })
        .ok_or_else(|| "an editable benchmark track is missing".into())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let first = args
        .next()
        .ok_or("usage: profile_parallel_benchmark VCF SAMPLE PROJECT_DIR BUNDLE_JSON")?;
    if first == "--serial-existing"
        || first == "--devices-existing"
        || first == "--dbnsfp-threads-existing"
        || first == "--full-threads-existing"
        || first == "--parallel-existing"
    {
        let project = Project::open(PathBuf::from(
            args.next().ok_or("missing project directory")?,
        ))?;
        let track = benchmark_track(&project)?;
        let evaluation = EvaluationService::new();
        if first == "--parallel-existing" {
            let threads: u16 = args
                .next()
                .ok_or("missing thread count")?
                .parse()
                .map_err(|_| "invalid thread count")?;
            let pool = LocalComputePool::new();
            let started = Instant::now();
            let result = run_profile(&pool, &evaluation, &project, &track.id, threads)?;
            println!(
                "full_threads={threads} elapsed_seconds={:.3} mutations={} devices={}",
                started.elapsed().as_secs_f64(),
                result.active_mutations,
                result.device_coverage.len()
            );
            return Ok(());
        }
        if first == "--full-threads-existing" {
            let threads: u16 = args
                .next()
                .ok_or("missing thread count")?
                .parse()
                .map_err(|_| "invalid thread count")?;
            let device_ids: Vec<_> = DEVICES.iter().map(|device| (*device).to_owned()).collect();
            let serial_started = Instant::now();
            let expected =
                profile_track(&evaluation, &project, &track.id, &device_ids, |_, _, _| {
                    Ok(())
                })?;
            println!(
                "full_threads=1 elapsed_seconds={:.3}",
                serial_started.elapsed().as_secs_f64()
            );
            let pool = LocalComputePool::new();
            let parallel_started = Instant::now();
            let observed = run_profile(&pool, &evaluation, &project, &track.id, threads)?;
            if observed != expected {
                return Err(format!("full profile output changed at {threads} threads").into());
            }
            println!(
                "full_threads={threads} elapsed_seconds={:.3}",
                parallel_started.elapsed().as_secs_f64()
            );
            return Ok(());
        }
        if first == "--dbnsfp-threads-existing" {
            let device = "org.dgw.builtin.dbnsfp";
            let expected = profile_track(
                &evaluation,
                &project,
                &track.id,
                &[device.to_owned()],
                |_, _, _| Ok(()),
            )?;
            let pool = LocalComputePool::new();
            for threads in [2_u16, 4, 8] {
                let started = Instant::now();
                let mut result = pool.parallel_map_with_progress(
                    threads,
                    vec![device.to_owned()],
                    |device_id, _progress| {
                        dgw_core::profile_track_with_threads(
                            &evaluation,
                            &project,
                            &track.id,
                            &[device_id],
                            usize::from(threads),
                            |_, _, _| Ok(()),
                        )
                        .map_err(|error| error.to_string())
                    },
                    |_: ()| Ok(()),
                )?;
                let observed = result.pop().ok_or("dbNSFP profile result is missing")?;
                if observed != expected {
                    return Err(format!("dbNSFP output changed at {threads} threads").into());
                }
                println!(
                    "dbnsfp_threads={threads} elapsed_seconds={:.3}",
                    started.elapsed().as_secs_f64()
                );
            }
            return Ok(());
        }
        if first == "--devices-existing" {
            for device in DEVICES {
                let started = Instant::now();
                let result = profile_track(
                    &evaluation,
                    &project,
                    &track.id,
                    &[device.to_owned()],
                    |_, _, _| Ok(()),
                )?;
                println!(
                    "device={device} elapsed_seconds={:.3} mutations={} exact_matches={}",
                    started.elapsed().as_secs_f64(),
                    result.active_mutations,
                    result.device_coverage[0].exact_matches
                );
            }
            return Ok(());
        }
        let device_ids: Vec<_> = DEVICES.iter().map(|device| (*device).to_owned()).collect();
        let started = Instant::now();
        let result = profile_track(&evaluation, &project, &track.id, &device_ids, |_, _, _| {
            Ok(())
        })?;
        println!(
            "original_serial elapsed_seconds={:.3} mutations={} devices={}",
            started.elapsed().as_secs_f64(),
            result.active_mutations,
            result.device_coverage.len()
        );
        return Ok(());
    }
    let source_vcf = PathBuf::from(first);
    let sample = args.next().ok_or("missing sample")?;
    let project_path = PathBuf::from(args.next().ok_or("missing project directory")?);
    let bundle_path = PathBuf::from(args.next().ok_or("missing resource bundle JSON")?);
    let bundle: ResourceBundle = serde_json::from_reader(File::open(bundle_path)?)?;
    let project = Project::create(CreateProjectRequest {
        project_path,
        name: "Track Profiler parallel benchmark".into(),
        source_vcf_path: source_vcf,
        selected_sample: sample,
        resource_bundle: bundle,
    })?;
    let base_track = project.snapshot()?.active_track;
    let selection = project.resolve_selection(
        &VariantSelection::AllTrack {
            track_id: base_track.id.clone(),
            exclusions: Vec::new(),
        },
        100_000,
    )?;
    if selection.truncated || selection.variants.is_empty() {
        return Err("benchmark selection was empty or truncated".into());
    }
    let track = project.duplicate_track(&base_track.id, "Parallel benchmark")?;
    let current = project.effective_variants_for_track(&track.id)?;
    let request = RandomizerRequest {
        selected_variants: selection.variants,
        amount: 100,
        seed: 42,
        substitution_pattern: SubstitutionPattern::Uniform,
        transition_probability: 67,
    };
    let plan = plan_randomizer(&current, &request)?;
    let changes: Vec<_> = plan
        .proposals
        .iter()
        .map(|proposal| CompoundMutationChange {
            haplotype: proposal.haplotype,
            edit: proposal.edit.clone(),
        })
        .collect();
    let layer = project.stage_compound_mutation_layer(
        &track.id,
        &track.head_state_id,
        "org.dgw.builtin.mutation-generator",
        plan.randomized_positions,
        &changes,
        Some("Parallel benchmark input".into()),
    )?;
    project.apply_compound_mutation_layer(&track.id, &layer.id)?;

    let pool = LocalComputePool::new();
    let evaluation = EvaluationService::new();
    eprintln!(
        "warmup: {} selected alleles, {} active mutations, {} Evidence devices",
        request.selected_variants.len(),
        changes.len(),
        DEVICES.len()
    );
    let device_ids: Vec<_> = DEVICES.iter().map(|device| (*device).to_owned()).collect();
    let expected = profile_track(&evaluation, &project, &track.id, &device_ids, |_, _, _| {
        Ok(())
    })?;
    let mut timings = BTreeMap::<u16, Vec<Duration>>::new();
    for threads in [1_u16, 2, 4, 4, 2, 1] {
        let started = Instant::now();
        let observed = run_profile(&pool, &evaluation, &project, &track.id, threads)?;
        let elapsed = started.elapsed();
        if observed != expected {
            return Err(format!("scientific output changed at {threads} threads").into());
        }
        println!(
            "threads={threads} elapsed_seconds={:.3}",
            elapsed.as_secs_f64()
        );
        timings.entry(threads).or_default().push(elapsed);
    }
    let mut baseline = Duration::ZERO;
    for threads in [1_u16, 2, 4] {
        let value = median(timings.get_mut(&threads).expect("thread count was run"));
        if threads == 1 {
            baseline = value;
        }
        println!(
            "summary threads={threads} median_seconds={:.3} speedup={:.2}x",
            value.as_secs_f64(),
            baseline.as_secs_f64() / value.as_secs_f64()
        );
    }
    Ok(())
}
