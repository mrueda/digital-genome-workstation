use crate::{
    DgwError, EvaluationService, EvidenceResult, EvidenceStatus, Project, Result,
    TrackComparisonLocus, VariantKey, CONSEQUENCE_DEVICE_ID,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionComparisonReport {
    pub revision: String,
    pub device_ids: Vec<String>,
    pub resource_fingerprints: BTreeMap<String, String>,
    pub counts: BTreeMap<String, u64>,
    pub total: u64,
}

fn fingerprint(evidence: &EvidenceResult) -> Option<BTreeSet<(String, String, String)>> {
    if evidence.status != EvidenceStatus::Found || evidence.records.is_empty() {
        return None;
    }
    evidence
        .records
        .iter()
        .map(|record| {
            let effect = record.get("effect")?;
            let impact = record.get("impact")?;
            if effect.trim().is_empty() || impact.trim().is_empty() {
                return None;
            }
            Some((
                record.get("featureId").cloned().unwrap_or_default(),
                effect.clone(),
                impact.clone(),
            ))
        })
        .collect()
}

/// Compare sets of independently predicted alleles, never a combined haplotype effect.
pub fn classify(
    locus: &TrackComparisonLocus,
    evidence: &BTreeMap<VariantKey, EvidenceResult>,
) -> &'static str {
    let dosage = |variants: &[crate::EffectiveVariant]| {
        variants
            .iter()
            .map(|v| {
                usize::from(v.haplotype1_alt)
                    + usize::from(v.haplotype2_alt)
                    + usize::from(v.unphased_alt)
            })
            .sum::<usize>()
    };
    if dosage(&locus.current) < dosage(&locus.source) {
        return "referenceRestoration";
    }
    let side = |variants: &[crate::EffectiveVariant]| -> Option<Vec<_>> {
        let mut signatures = Vec::new();
        for variant in variants {
            let signature = fingerprint(evidence.get(&variant.key)?)?;
            let copies = usize::from(variant.haplotype1_alt)
                + usize::from(variant.haplotype2_alt)
                + usize::from(variant.unphased_alt);
            for _ in 0..copies {
                signatures.push(signature.clone());
            }
        }
        signatures.sort();
        Some(signatures)
    };
    match (side(&locus.source), side(&locus.current)) {
        (Some(a), Some(b)) => {
            if a == b {
                "same"
            } else {
                "different"
            }
        }
        _ => "missing",
    }
}

pub fn report_path(project: &Project, job_id: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(job_id)
        .map_err(|_| DgwError::Project("invalid comparison job ID".into()))?;
    Ok(project
        .root()
        .join("artifacts")
        .join(format!("comparison-{job_id}.sqlite")))
}

pub fn resources(project: &Project, ids: &[String]) -> Result<BTreeMap<String, String>> {
    ids.iter()
        .map(|id| {
            Ok((
                id.clone(),
                crate::evaluation::device_resource_fingerprint(
                    &project.manifest().resource_bundle,
                    &project.manifest().resource_bundle_fingerprint,
                    id,
                )?,
            ))
        })
        .collect()
}

pub fn run<F: FnMut(u8, &str) -> Result<()>>(
    project: &Project,
    service: &EvaluationService,
    track_id: &str,
    job_id: &str,
    expected_revision: &str,
    ids: &[String],
    mut progress: F,
) -> Result<PredictionComparisonReport> {
    if !ids.iter().any(|id| id == CONSEQUENCE_DEVICE_ID) {
        return Err(DgwError::Project(
            "Activate Variant Consequences to compare predictions".into(),
        ));
    }
    progress(5, "Indexing changed loci")?;
    let index = project.build_track_comparison_index(track_id)?;
    if index.revision != expected_revision {
        return Err(DgwError::Project(
            "Track changed before comparison started".into(),
        ));
    }
    let resource_fingerprints = resources(project, ids)?;
    let mut rows = Vec::new();
    for offset in (0..index.changed_keys.len()).step_by(200) {
        progress(10, "Reconstructing source and current alleles")?;
        rows.extend(
            project
                .changed_comparison_page(&index, offset as u64, 200)?
                .rows,
        );
    }
    let keys: Vec<_> = rows
        .iter()
        .flat_map(|row| row.source.iter().chain(row.current.iter()))
        .map(|v| v.key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    progress(
        20,
        "Comparing predictions: loading cached evidence and batching new alleles",
    )?;
    let evidence = service.comparison_consequences(project, &keys)?;
    progress(85, "Writing comparison results")?;
    let path = report_path(project, job_id)?;
    if path.exists() {
        return Err(DgwError::Project("comparison result already exists".into()));
    }
    let temporary = tempfile::NamedTempFile::new_in(project.root().join("artifacts"))?;
    let mut db = rusqlite::Connection::open(temporary.path())?;
    db.execute_batch("CREATE TABLE results (ordinal INTEGER PRIMARY KEY, outcome TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX outcome_idx ON results(outcome, ordinal);")?;
    let tx = db.transaction()?;
    let mut counts = BTreeMap::new();
    for (ordinal, row) in rows.iter().enumerate() {
        let outcome = classify(row, &evidence);
        *counts.entry(outcome.to_owned()).or_insert(0) += 1;
        let snapshot = PredictionRow {
            outcome: outcome.into(),
            locus: row.clone(),
            evidence: row
                .source
                .iter()
                .chain(row.current.iter())
                .filter_map(|v| {
                    evidence
                        .get(&v.key)
                        .map(|result| (v.key.stable_key(), result.clone()))
                })
                .collect(),
        };
        tx.execute(
            "INSERT INTO results VALUES (?1, ?2, ?3)",
            rusqlite::params![ordinal as u64, outcome, serde_json::to_string(&snapshot)?],
        )?;
    }
    tx.commit()?;
    progress(95, "Checking track and resource revision")?;
    if project.track_comparison_revision(track_id)? != index.revision
        || resources(project, ids)? != resource_fingerprints
    {
        return Err(DgwError::Project(
            "Inputs changed during comparison; run it again".into(),
        ));
    }
    drop(db);
    temporary.persist_noclobber(&path).map_err(|error| {
        DgwError::Project(format!(
            "Could not publish comparison report: {}",
            error.error
        ))
    })?;
    Ok(PredictionComparisonReport {
        revision: index.revision,
        device_ids: ids.to_vec(),
        resource_fingerprints,
        counts,
        total: rows.len() as u64,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionPage {
    pub stale: bool,
    pub total: u64,
    pub rows: Vec<PredictionRow>,
}
#[derive(Serialize, Deserialize)]
pub struct PredictionRow {
    pub outcome: String,
    pub locus: TrackComparisonLocus,
    pub evidence: BTreeMap<String, EvidenceResult>,
}

pub fn page(
    project: &Project,
    job_id: &str,
    ids: &[String],
    outcome: Option<&str>,
    offset: u64,
) -> Result<PredictionPage> {
    let (track_id, result) = match project.background_job(job_id) {
        Ok(job) => {
            if job.operation != "trackPredictionComparison"
                || job.status != crate::BackgroundJobStatus::Completed
            {
                return Err(DgwError::Project("comparison is not complete".into()));
            }
            (
                job.track_id,
                job.result
                    .ok_or_else(|| DgwError::Project("missing comparison report".into()))?,
            )
        }
        Err(_) => {
            // Clearing routine Jobs history must not invalidate an open saved report.
            let run = project.device_run(job_id)?;
            if run.operation != "trackPredictionComparison"
                || run.status != crate::DeviceRunStatus::Completed
            {
                return Err(DgwError::Project("comparison is not complete".into()));
            }
            (run.track_id, run.result_summary)
        }
    };
    let report: PredictionComparisonReport = serde_json::from_value(result)?;
    if project.track_comparison_revision(&track_id)? != report.revision
        || ids != report.device_ids
        || resources(project, ids)? != report.resource_fingerprints
    {
        return Ok(PredictionPage {
            stale: true,
            total: 0,
            rows: vec![],
        });
    }
    let db = rusqlite::Connection::open_with_flags(
        report_path(project, job_id)?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let total = db.query_row(
        "SELECT COUNT(*) FROM results WHERE (?1 IS NULL OR outcome = ?1)",
        [outcome],
        |row| row.get(0),
    )?;
    let mut statement = db.prepare("SELECT outcome, payload FROM results WHERE (?1 IS NULL OR outcome = ?1) ORDER BY ordinal LIMIT 200 OFFSET ?2")?;
    let records = statement.query_map(rusqlite::params![outcome, offset], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut rows = Vec::new();
    for record in records {
        let (_, payload) = record?;
        rows.push(serde_json::from_str(&payload)?);
    }
    Ok(PredictionPage {
        stale: false,
        total,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EffectiveVariant, VariantOrigin};
    fn variant(alt: &str, one: bool, two: bool) -> EffectiveVariant {
        EffectiveVariant {
            key: VariantKey {
                assembly: "b37".into(),
                contig: "1".into(),
                position: 100,
                reference: "A".into(),
                alternate: alt.into(),
            },
            haplotype1_alt: one,
            haplotype2_alt: two,
            unphased_alt: false,
            unphased_slot: None,
            origin: VariantOrigin::Observed,
            edit_ids: vec![],
            source_key: None,
            source_info: BTreeMap::new(),
        }
    }
    fn result(effect: &str) -> EvidenceResult {
        EvidenceResult {
            source: "Variant Consequences".into(),
            status: EvidenceStatus::Found,
            records: vec![BTreeMap::from([
                ("effect".into(), effect.into()),
                ("impact".into(), "HIGH".into()),
                ("featureId".into(), "transcript1".into()),
            ])],
            message: None,
        }
    }
    #[test]
    fn comparisons_are_not_just_impact_scores_and_missing_is_not_same() {
        let a = variant("C", true, false);
        let b = variant("T", true, false);
        let row = TrackComparisonLocus {
            contig: "1".into(),
            position: 100,
            reference: "A".into(),
            source: vec![a.clone()],
            current: vec![b.clone()],
            changed: true,
        };
        let mut evidence = BTreeMap::from([
            (a.key.clone(), result("stop_gained")),
            (b.key.clone(), result("frameshift")),
        ]);
        assert_eq!(classify(&row, &evidence), "different");
        evidence.insert(b.key.clone(), result("stop_gained"));
        assert_eq!(classify(&row, &evidence), "same");
        evidence.remove(&b.key);
        assert_eq!(classify(&row, &evidence), "missing");
        assert_eq!(
            classify(
                &TrackComparisonLocus {
                    current: vec![],
                    ..row
                },
                &evidence
            ),
            "referenceRestoration"
        );
    }
    #[test]
    fn merging_alts_with_identical_consequences_does_not_invent_a_prediction_change() {
        let a = variant("C", true, false);
        let b = variant("T", false, true);
        let row = TrackComparisonLocus {
            contig: "1".into(),
            position: 100,
            reference: "A".into(),
            source: vec![a.clone(), b.clone()],
            current: vec![variant("C", true, true)],
            changed: true,
        };
        let evidence =
            BTreeMap::from([(a.key, result("synonymous")), (b.key, result("synonymous"))]);
        assert_eq!(classify(&row, &evidence), "same");
    }
}
