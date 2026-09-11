//! Exercises the production comparison coordinator on a disposable project copy.
use dgw_core::{
    prediction_comparison, BackgroundJob, BackgroundJobStatus, EvaluationService, Project,
    CONSEQUENCE_DEVICE_ID,
};
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: compare_predictions DISPOSABLE_PROJECT_COPY")?;
    let project = Project::open(path)?;
    let track = project
        .list_tracks()?
        .into_iter()
        .find(|track| !track.read_only)
        .ok_or("no working track")?;
    let id = uuid::Uuid::new_v4().to_string();
    let revision = project.track_comparison_revision(&track.id)?;
    let ids = vec![CONSEQUENCE_DEVICE_ID.to_owned()];
    let started = Instant::now();
    let mut previous = String::new();
    let report = prediction_comparison::run(
        &project,
        &EvaluationService::new(),
        &track.id,
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
    println!(
        "elapsed_seconds={:.3} changed_loci={} counts={:?}",
        started.elapsed().as_secs_f64(),
        report.total,
        report.counts
    );
    assert_eq!(report.counts.values().sum::<u64>(), report.total);
    let now = chrono::Utc::now();
    project.save_background_job(&BackgroundJob { id: id.clone(), operation: "trackPredictionComparison".into(), device_id: CONSEQUENCE_DEVICE_ID.into(), track_id: track.id.clone(), status: BackgroundJobStatus::Completed, progress: 100, stage: "completed".into(), message: "Comparison validated".into(), worker_threads: 1, request: serde_json::json!({"stateId": track.head_state_id, "revision": revision, "deviceIds": ids}), result: Some(serde_json::to_value(&report)?), error: None, created_at: now, updated_at: now })?;
    let reopened = Project::open(project.root())?;
    for (outcome, expected) in &report.counts {
        let page = prediction_comparison::page(&reopened, &id, &ids, Some(outcome), 0)?;
        assert_eq!(page.total, *expected);
        assert!(!page.stale);
        assert!(page.rows.len() <= 200);
    }
    println!("report_job={id} reopen_and_filters=passed");
    Ok(())
}
