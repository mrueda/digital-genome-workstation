use crate::evaluation::BatchEvidenceSignal;
use crate::{DgwError, EvaluationService, EvidenceStatus, Project, Result, CONSEQUENCE_DEVICE_ID};
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::mpsc::{self, Sender};

pub const TRACK_PROFILE_EVIDENCE_DEVICES: [&str; 3] = [
    CONSEQUENCE_DEVICE_ID,
    "org.dgw.builtin.clinvar",
    "org.dgw.builtin.cosmic",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackProfileDeviceCoverage {
    pub id: String,
    pub evaluated: u32,
    pub total: u32,
    pub exact_matches: u64,
    pub unavailable: u32,
    pub errors: u32,
    pub no_transcript_feature: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackEvidenceProfileResult {
    pub track_id: String,
    pub state_id: String,
    pub profile_input_fingerprint: String,
    pub active_mutations: u32,
    pub evaluated_mutations: u32,
    pub impact_delta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub higher_impact_mutations: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lower_impact_mutations: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unchanged_impact_mutations: Option<u32>,
    pub device_coverage: Vec<TrackProfileDeviceCoverage>,
    pub limitation: String,
}

pub fn normalized_track_profile_devices(device_ids: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    device_ids
        .iter()
        .filter(|device_id| TRACK_PROFILE_EVIDENCE_DEVICES.contains(&device_id.as_str()))
        .filter(|device_id| seen.insert((*device_id).clone()))
        .cloned()
        .collect()
}

/// Bounded in-process execution used by desktop and MCP background jobs.
/// Project mutations remain outside this pool.
#[derive(Debug, Default)]
pub struct LocalComputePool;

impl LocalComputePool {
    pub fn new() -> Self {
        Self
    }

    /// Run one coordinator inside a bounded Rayon pool. Code invoked by the
    /// coordinator can use Rayon internally without escaping the job's worker
    /// limit.
    pub fn run<R, F>(&self, thread_limit: u16, operation: F) -> std::result::Result<R, String>
    where
        R: Send,
        F: FnOnce() -> std::result::Result<R, String> + Send,
    {
        let pool = ThreadPoolBuilder::new()
            .num_threads(usize::from(thread_limit.max(1)))
            .thread_name(|index| format!("dgw-job-{index}"))
            .build()
            .map_err(|error| format!("could not create the local worker pool: {error}"))?;
        pool.install(operation)
    }

    pub fn parallel_map_with_progress<T, R, P, F, G>(
        &self,
        thread_limit: u16,
        items: Vec<T>,
        operation: F,
        mut on_progress: G,
    ) -> std::result::Result<Vec<R>, String>
    where
        T: Send,
        R: Send,
        P: Send,
        F: Fn(T, Sender<P>) -> std::result::Result<R, String> + Send + Sync,
        G: FnMut(P) -> std::result::Result<(), String>,
    {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let threads = usize::from(thread_limit.max(1));
        let pool = ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|index| format!("dgw-job-{index}"))
            .build()
            .map_err(|error| format!("could not create the local worker pool: {error}"))?;
        let (progress_tx, progress_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let worker = scope.spawn(move || {
                pool.install(|| {
                    items
                        .into_par_iter()
                        .map(|item| operation(item, progress_tx.clone()))
                        .collect::<std::result::Result<Vec<_>, _>>()
                })
            });
            let mut progress_error = None;
            for progress in progress_rx {
                if progress_error.is_none() {
                    progress_error = on_progress(progress).err();
                }
            }
            let outcome = worker
                .join()
                .map_err(|_| "local worker pool panicked".to_string())?;
            if let Some(error) = progress_error {
                return Err(error);
            }
            outcome
        })
    }
}

pub fn merge_track_profile_results(
    track_id: String,
    state_id: String,
    profile_input_fingerprint: String,
    results: Vec<TrackEvidenceProfileResult>,
) -> Result<TrackEvidenceProfileResult> {
    let first = results
        .first()
        .ok_or_else(|| DgwError::Tool("Track Profiler produced no device results".into()))?;
    let consequence = results.iter().find(|result| {
        result
            .device_coverage
            .iter()
            .any(|coverage| coverage.id == CONSEQUENCE_DEVICE_ID)
    });
    let active_mutations = first.active_mutations;
    let limitation = first.limitation.clone();
    let evaluated_mutations = consequence
        .map(|result| result.evaluated_mutations)
        .unwrap_or_default();
    let impact_delta = consequence.and_then(|result| result.impact_delta);
    let higher_impact_mutations = consequence.and_then(|result| result.higher_impact_mutations);
    let lower_impact_mutations = consequence.and_then(|result| result.lower_impact_mutations);
    let unchanged_impact_mutations =
        consequence.and_then(|result| result.unchanged_impact_mutations);
    Ok(TrackEvidenceProfileResult {
        track_id,
        state_id,
        profile_input_fingerprint,
        active_mutations,
        evaluated_mutations,
        impact_delta,
        higher_impact_mutations,
        lower_impact_mutations,
        unchanged_impact_mutations,
        device_coverage: results
            .into_iter()
            .flat_map(|result| result.device_coverage)
            .collect(),
        limitation,
    })
}

/// Run independent Evidence devices on one bounded Rayon pool and reject the
/// combined profile if the track changes before completion.
pub fn profile_track_parallel_with_threads<F>(
    compute_pool: &LocalComputePool,
    evaluation: &EvaluationService,
    project: &Project,
    track_id: &str,
    requested_device_ids: &[String],
    worker_threads: u16,
    mut on_progress: F,
) -> Result<TrackEvidenceProfileResult>
where
    F: FnMut(&str, usize, usize) -> Result<()>,
{
    let device_ids = normalized_track_profile_devices(requested_device_ids);
    if device_ids.is_empty() {
        return Err(DgwError::InvalidDevice(
            "Track Profiler requires at least one active Evidence device".into(),
        ));
    }
    let captured_track = project.track(track_id)?;
    let fingerprint = project.track_profile_input_fingerprint(track_id, &device_ids)?;
    let profile_track_id = track_id.to_owned();
    let profile_threads = usize::from(worker_threads.max(1));
    let results = compute_pool
        .parallel_map_with_progress(
            worker_threads,
            device_ids.clone(),
            |device_id, progress| {
                profile_track_with_threads(
                    evaluation,
                    project,
                    &profile_track_id,
                    std::slice::from_ref(&device_id),
                    profile_threads,
                    |reported_device, processed, total| {
                        progress
                            .send((reported_device.to_owned(), processed, total))
                            .map_err(|error| DgwError::Tool(error.to_string()))
                    },
                )
                .map_err(|error| error.to_string())
            },
            |(device_id, processed, total)| {
                on_progress(&device_id, processed, total).map_err(|error| error.to_string())
            },
        )
        .map_err(DgwError::Tool)?;
    let current_fingerprint = project.track_profile_input_fingerprint(track_id, &device_ids)?;
    if current_fingerprint != fingerprint {
        return Err(DgwError::Project(
            "the track changed while Evidence profiling was running; run it again".into(),
        ));
    }
    merge_track_profile_results(
        track_id.into(),
        captured_track.head_state_id,
        fingerprint,
        results,
    )
}

/// Evaluate every active mutation on one track with the same additive model
/// displayed by Track Monitor. Job scheduling and cancellation remain host
/// concerns; `on_progress` can abort by returning an error.
pub fn profile_track<F>(
    evaluation: &EvaluationService,
    project: &Project,
    track_id: &str,
    requested_device_ids: &[String],
    on_progress: F,
) -> Result<TrackEvidenceProfileResult>
where
    F: FnMut(&str, usize, usize) -> Result<()> + Send,
{
    profile_track_with_threads(
        evaluation,
        project,
        track_id,
        requested_device_ids,
        1,
        on_progress,
    )
}

pub fn profile_track_with_threads<F>(
    evaluation: &EvaluationService,
    project: &Project,
    track_id: &str,
    requested_device_ids: &[String],
    worker_threads: usize,
    mut on_progress: F,
) -> Result<TrackEvidenceProfileResult>
where
    F: FnMut(&str, usize, usize) -> Result<()> + Send,
{
    let device_ids = normalized_track_profile_devices(requested_device_ids);
    if device_ids.is_empty() {
        return Err(DgwError::InvalidDevice(
            "Track Profiler requires at least one active Evidence device".into(),
        ));
    }

    let captured_track = project.track(track_id)?;
    let profile_input_fingerprint =
        project.track_profile_input_fingerprint(track_id, &device_ids)?;
    let mutations = project.active_track_mutations(track_id)?;
    if mutations.is_empty() {
        return Err(DgwError::Project(
            "the selected track has no active mutations to profile".into(),
        ));
    }
    let active_mutations = u32::try_from(mutations.len()).unwrap_or(u32::MAX);
    let mut unique = BTreeSet::new();
    for mutation in &mutations {
        unique.insert(mutation.source_variant.clone());
        if let Some(current) = &mutation.current_variant {
            unique.insert(current.clone());
        }
    }
    let variants: Vec<_> = unique.into_iter().collect();
    let mut device_coverage = Vec::with_capacity(device_ids.len());
    let mut evaluated_mutations = 0_u32;
    let mut impact_delta = None;
    let mut higher_impact_mutations = None;
    let mut lower_impact_mutations = None;
    let mut unchanged_impact_mutations = None;

    for device_id in &device_ids {
        on_progress(device_id, 0, variants.len())?;
        let signals = evaluation.evaluate_device_signals_with_threads(
            project,
            &variants,
            device_id,
            worker_threads,
            |processed, total| on_progress(device_id, processed, total),
        )?;

        let mut evaluated = 0_u32;
        let mut exact_matches = 0_u64;
        let mut unavailable = 0_u32;
        let mut errors = 0_u32;
        let mut no_transcript_feature = 0_u32;
        let mut device_impact_delta = 0.0_f64;
        let mut impact_complete = true;
        let mut device_higher = 0_u32;
        let mut device_lower = 0_u32;
        let mut device_unchanged = 0_u32;

        for mutation in &mutations {
            let source = signals.get(&mutation.source_variant);
            let current = mutation
                .current_variant
                .as_ref()
                .and_then(|variant| signals.get(variant));
            let terminal = |signal: Option<&BatchEvidenceSignal>| {
                signal.is_some_and(|signal| {
                    matches!(
                        signal.status,
                        EvidenceStatus::Found | EvidenceStatus::NoExactMatch
                    )
                })
            };
            if terminal(source) && (mutation.current_variant.is_none() || terminal(current)) {
                evaluated = evaluated.saturating_add(1);
            }
            if let Some(current) = current {
                exact_matches = exact_matches.saturating_add(u64::from(current.exact_match_count));
                no_transcript_feature =
                    no_transcript_feature.saturating_add(u32::from(current.no_transcript_feature));
            }
            let mut mutation_unavailable = false;
            let mut mutation_error = false;
            for status in [source, current]
                .into_iter()
                .flatten()
                .map(|signal| &signal.status)
            {
                mutation_unavailable |= *status == EvidenceStatus::ResourceUnavailable;
                mutation_error |= *status == EvidenceStatus::Error;
            }
            unavailable = unavailable.saturating_add(u32::from(mutation_unavailable));
            errors = errors.saturating_add(u32::from(mutation_error));

            if device_id == CONSEQUENCE_DEVICE_ID {
                let source_impact = source.and_then(|signal| signal.impact_signal);
                let current_impact = if mutation.current_variant.is_none() {
                    Some(0.0)
                } else {
                    current.and_then(|signal| signal.impact_signal)
                };
                match (source_impact, current_impact) {
                    (Some(source), Some(current)) => {
                        let delta = current - source;
                        device_impact_delta += delta;
                        if delta > f64::EPSILON {
                            device_higher = device_higher.saturating_add(1);
                        } else if delta < -f64::EPSILON {
                            device_lower = device_lower.saturating_add(1);
                        } else {
                            device_unchanged = device_unchanged.saturating_add(1);
                        }
                    }
                    _ => impact_complete = false,
                }
            }
        }

        if device_id == CONSEQUENCE_DEVICE_ID {
            evaluated_mutations = if impact_complete {
                active_mutations
            } else {
                mutations
                    .iter()
                    .filter(|mutation| {
                        let source = signals
                            .get(&mutation.source_variant)
                            .and_then(|signal| signal.impact_signal);
                        let current = if mutation.current_variant.is_none() {
                            Some(0.0)
                        } else {
                            mutation
                                .current_variant
                                .as_ref()
                                .and_then(|variant| signals.get(variant))
                                .and_then(|signal| signal.impact_signal)
                        };
                        source.is_some() && current.is_some()
                    })
                    .count() as u32
            };
            if impact_complete {
                impact_delta = Some(device_impact_delta);
            }
            higher_impact_mutations = Some(device_higher);
            lower_impact_mutations = Some(device_lower);
            unchanged_impact_mutations = Some(device_unchanged);
        }
        device_coverage.push(TrackProfileDeviceCoverage {
            id: device_id.clone(),
            evaluated,
            total: active_mutations,
            exact_matches,
            unavailable,
            errors,
            no_transcript_feature,
        });
    }

    let current_track = project.track(track_id)?;
    if current_track.head_state_id != captured_track.head_state_id
        || current_track.bypassed_edit_ids != captured_track.bypassed_edit_ids
    {
        return Err(DgwError::Project(
            "the track changed while Evidence profiling was running; run it again".into(),
        ));
    }

    Ok(TrackEvidenceProfileResult {
        track_id: track_id.into(),
        state_id: captured_track.head_state_id,
        profile_input_fingerprint,
        active_mutations,
        evaluated_mutations,
        impact_delta,
        higher_impact_mutations,
        lower_impact_mutations,
        unchanged_impact_mutations,
        device_coverage,
        limitation: "Additive exact-allele evidence. Nearby interactions, phase-dependent combined consequences, penetrance, and disease probability are not modeled.".into(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn profile_score_json_round_trip_preserves_exact_value() {
        let score = 1990.6499999998614_f64;
        let encoded = serde_json::to_string(&score).unwrap();
        let decoded: f64 = serde_json::from_str(&encoded).unwrap();
        assert_eq!(score.to_bits(), decoded.to_bits());
    }
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    fn profile(id: &str) -> TrackEvidenceProfileResult {
        let consequence = id == CONSEQUENCE_DEVICE_ID;
        TrackEvidenceProfileResult {
            track_id: "track".into(),
            state_id: "state".into(),
            profile_input_fingerprint: format!("single-{id}"),
            active_mutations: 3,
            evaluated_mutations: if consequence { 3 } else { 0 },
            impact_delta: consequence.then_some(-1.0),
            higher_impact_mutations: consequence.then_some(0),
            lower_impact_mutations: consequence.then_some(2),
            unchanged_impact_mutations: consequence.then_some(1),
            device_coverage: vec![TrackProfileDeviceCoverage {
                id: id.into(),
                evaluated: 3,
                total: 3,
                exact_matches: 1,
                unavailable: 0,
                errors: 0,
                no_transcript_feature: 0,
            }],
            limitation: "test limitation".into(),
        }
    }

    #[test]
    fn profile_device_selection_is_supported_ordered_and_unique() {
        let requested = vec![
            "org.dgw.builtin.clinvar".into(),
            "unsupported".into(),
            CONSEQUENCE_DEVICE_ID.into(),
            "org.dgw.builtin.clinvar".into(),
        ];

        assert_eq!(
            normalized_track_profile_devices(&requested),
            vec![
                "org.dgw.builtin.clinvar".to_string(),
                CONSEQUENCE_DEVICE_ID.to_string()
            ]
        );
    }

    #[test]
    fn merge_keeps_consequence_meter_and_requested_device_order() {
        let merged = merge_track_profile_results(
            "track".into(),
            "state".into(),
            "combined".into(),
            vec![
                profile("org.dgw.builtin.clinvar"),
                profile(CONSEQUENCE_DEVICE_ID),
            ],
        )
        .unwrap();

        assert_eq!(merged.profile_input_fingerprint, "combined");
        assert_eq!(merged.impact_delta, Some(-1.0));
        assert_eq!(merged.evaluated_mutations, 3);
        assert_eq!(merged.device_coverage[0].id, "org.dgw.builtin.clinvar");
        assert_eq!(merged.device_coverage[1].id, CONSEQUENCE_DEVICE_ID);
    }

    #[test]
    fn parallel_map_preserves_input_order_and_reports_progress() {
        let executor = LocalComputePool::new();
        let progress = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&progress);
        let output = executor
            .parallel_map_with_progress(
                2,
                vec![1, 2, 3, 4],
                |value, sender| {
                    sender.send(value).map_err(|error| error.to_string())?;
                    std::thread::sleep(Duration::from_millis(2));
                    Ok(value * 2)
                },
                move |_| {
                    observed.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .expect("parallel execution should complete");

        assert_eq!(output, vec![2, 4, 6, 8]);
        assert_eq!(progress.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn full_thread_bound_is_available_to_nested_variant_work() {
        let executor = LocalComputePool::new();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let observed_active = Arc::clone(&active);
        let observed_maximum = Arc::clone(&maximum);
        executor
            .parallel_map_with_progress(
                4,
                vec![()],
                move |(), _progress: Sender<()>| {
                    (0..8).into_par_iter().for_each(|_| {
                        let concurrent = observed_active.fetch_add(1, Ordering::SeqCst) + 1;
                        observed_maximum.fetch_max(concurrent, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(4));
                        observed_active.fetch_sub(1, Ordering::SeqCst);
                    });
                    Ok(())
                },
                |()| Ok(()),
            )
            .expect("nested variant work should complete");

        assert!(maximum.load(Ordering::SeqCst) > 1);
    }
}
