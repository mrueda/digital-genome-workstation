use dgw_core::{TrackEvidenceProfileResult, CONSEQUENCE_DEVICE_ID};
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use std::sync::mpsc::{self, Sender};

/// Bounded, in-process parallel execution for one desktop background job.
///
/// Project mutation remains outside this executor. Callers use it only for
/// independent read/compute stages, then apply the combined result serially.
#[derive(Debug, Default)]
pub struct LocalComputePool;

impl LocalComputePool {
    pub fn new() -> Self {
        Self
    }

    pub fn parallel_map_with_progress<T, R, P, F, G>(
        &self,
        thread_limit: u16,
        items: Vec<T>,
        operation: F,
        mut on_progress: G,
    ) -> Result<Vec<R>, String>
    where
        T: Send,
        R: Send,
        P: Send,
        F: Fn(T, Sender<P>) -> Result<R, String> + Send + Sync,
        G: FnMut(P) -> Result<(), String>,
    {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        // Operations may expose nested Rayon work, such as indexed Evidence
        // chunks. Keep the user's full bound even with fewer top-level items.
        let threads = usize::from(thread_limit.max(1));
        let pool = ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|index| format!("dgw-job-{index}"))
            .build()
            .map_err(|error| format!("could not create the desktop worker pool: {error}"))?;
        let (progress_tx, progress_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let worker = scope.spawn(move || {
                pool.install(|| {
                    items
                        .into_par_iter()
                        .map(|item| operation(item, progress_tx.clone()))
                        .collect::<Result<Vec<_>, _>>()
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
                .map_err(|_| "desktop worker pool panicked".to_string())?;
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
) -> Result<TrackEvidenceProfileResult, String> {
    let first = results
        .first()
        .ok_or_else(|| "Track Profiler produced no device results".to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use dgw_core::TrackProfileDeviceCoverage;
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
