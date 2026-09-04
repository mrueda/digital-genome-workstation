use crate::evaluation::BatchEvidenceSignal;
use crate::{DgwError, EvaluationService, EvidenceStatus, Project, Result, CONSEQUENCE_DEVICE_ID};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const TRACK_PROFILE_EVIDENCE_DEVICES: [&str; 4] = [
    CONSEQUENCE_DEVICE_ID,
    "org.dgw.builtin.dbnsfp",
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

/// Evaluate every active mutation on one track with the same additive model
/// displayed by Track Monitor. Job scheduling and cancellation remain host
/// concerns; `on_progress` can abort by returning an error.
pub fn profile_track<F>(
    evaluation: &EvaluationService,
    project: &Project,
    track_id: &str,
    requested_device_ids: &[String],
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
        let signals = evaluation.evaluate_device_signals(
            project,
            &variants,
            device_id,
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
    use super::*;

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
}
