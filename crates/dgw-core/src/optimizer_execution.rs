use crate::evaluation::{evidence_from_batch_signal, evidence_status_label};
use crate::{
    plan_optimizer_with_evidence, plan_saturation_optimizer, CompoundMutationChange,
    EvaluationService, EvidenceResult, EvidenceStatus, FocusContext, OptimizerAlleleEvidenceInput,
    OptimizerDirection, OptimizerMode, OptimizerObjective, OptimizerPlan, OptimizerRequest,
    Project, SaturationAlleleInput, VariantKey, VariantSelection, ADDITIVE_SCORE_LIMITATION,
    CONSEQUENCE_DEVICE_ID, MAX_OPTIMIZER_EDITS, MAX_SATURATION_POSITIONS,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;

pub const OPTIMIZER_CANCELLED_MARKER: &str = "__dgw_optimizer_cancelled__";
const CLINVAR_DEVICE_ID: &str = "org.dgw.builtin.clinvar";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerPreviewResult {
    pub mode: OptimizerMode,
    pub direction: OptimizerDirection,
    pub considered_positions: u32,
    pub evaluated_candidates: u32,
    pub excluded_positions: u32,
    pub improving_positions: u32,
    pub unchanged_or_tied_positions: u32,
    pub deferred_by_change_limit: u32,
    pub changed_positions: u32,
    pub generated_edits: u32,
    pub score_before: f64,
    pub score_after: f64,
    pub score_description: String,
    pub limitation: String,
    pub no_op_reason: Option<String>,
    pub candidate_comparisons_retained: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_layer_id: Option<String>,
}

struct OptimizerGroup {
    source_variant: VariantKey,
    changes: Vec<CompoundMutationChange>,
    score_delta: f64,
    improvement: f64,
}

pub fn optimizer_error_is_cancelled(error: &str) -> bool {
    error.contains(OPTIMIZER_CANCELLED_MARKER)
}

#[allow(clippy::too_many_arguments)]
pub fn prepare_optimizer_preview<F, C>(
    evaluation: &EvaluationService,
    project: &Project,
    track_id: &str,
    expected_head_state_id: &str,
    expected_bypassed_edit_ids: &[String],
    focus: &FocusContext,
    request: OptimizerRequest,
    selection: Option<&VariantSelection>,
    selection_limit: Option<u32>,
    worker_threads: usize,
    mut on_progress: F,
    is_cancelled: C,
) -> std::result::Result<OptimizerPreviewResult, String>
where
    F: FnMut(u8, &str, String) -> std::result::Result<(), String> + Send,
    C: Fn() -> bool + Sync,
{
    ensure_optimizer_track(
        project,
        track_id,
        expected_head_state_id,
        expected_bypassed_edit_ids,
    )?;
    check_cancelled(&is_cancelled)?;
    on_progress(
        3,
        "selection",
        "Resolving the selected genome positions".into(),
    )?;
    let request =
        resolve_optimizer_request(project, track_id, request, selection, selection_limit)?;
    validate_evidence_contract(&request)?;

    let considered_positions = request.selected_variants.len() as u32;
    let mut groups = Vec::new();
    let mut score_before = 0.0;
    let mut evaluated_candidates = 0_u32;
    let mut excluded_positions = 0_u32;
    let mut score_description = match request.mode {
        OptimizerMode::Saturation => "Comparable normalized transcript-consequence impact per allele copy across all non-reference SNV bases at the selected positions.".into(),
        OptimizerMode::Conservative => "Number of alternate allele copies in the selected scope; this measures distance from the reference, not biological burden.".into(),
    };
    let mut limitation = ADDITIVE_SCORE_LIMITATION.to_owned();

    match request.mode {
        OptimizerMode::Saturation => {
            const POSITION_CHUNK_SIZE: usize = 100_000;
            let chunk_count = request
                .selected_variants
                .len()
                .div_ceil(POSITION_CHUNK_SIZE)
                .max(1);
            for (chunk_index, selected_chunk) in request
                .selected_variants
                .chunks(POSITION_CHUNK_SIZE)
                .enumerate()
            {
                check_cancelled(&is_cancelled)?;
                let current = project
                    .effective_variants_for_track_at_loci(track_id, selected_chunk)
                    .map_err(|error| error.to_string())?;
                let candidates = optimizer_candidate_variants(selected_chunk);
                evaluated_candidates = evaluated_candidates
                    .saturating_add(candidates.len().min(u32::MAX as usize) as u32);
                let chunk_base = 8.0 + (chunk_index as f64 / chunk_count as f64) * 74.0;
                let chunk_span = 74.0 / chunk_count as f64;
                on_progress(
                    chunk_base.round() as u8,
                    "consequences",
                    format!(
                        "Predicting consequence batch {} of {} · {} alleles",
                        chunk_index + 1,
                        chunk_count,
                        candidates.len()
                    ),
                )?;
                let consequence = evaluation
                    .evaluate_device_signals_with_threads(
                        project,
                        &candidates,
                        CONSEQUENCE_DEVICE_ID,
                        worker_threads,
                        |processed, total| {
                            if is_cancelled() {
                                return Err(crate::DgwError::Tool(
                                    OPTIMIZER_CANCELLED_MARKER.into(),
                                ));
                            }
                            let fraction = fraction(processed, total);
                            on_progress(
                                (chunk_base + chunk_span * 0.58 * fraction).round() as u8,
                                "consequences",
                                format!(
                                    "Consequence Predictor batch {} of {} · {}/{} candidate alleles",
                                    chunk_index + 1,
                                    chunk_count,
                                    processed,
                                    total
                                ),
                            )
                            .map_err(crate::DgwError::Tool)
                        },
                    )
                    .map_err(|error| error.to_string())?;
                check_cancelled(&is_cancelled)?;
                let clinvar = evaluation
                    .evaluate_device_signals_with_threads(
                        project,
                        &candidates,
                        CLINVAR_DEVICE_ID,
                        worker_threads,
                        |processed, total| {
                            if is_cancelled() {
                                return Err(crate::DgwError::Tool(
                                    OPTIMIZER_CANCELLED_MARKER.into(),
                                ));
                            }
                            let fraction = fraction(processed, total);
                            on_progress(
                                (chunk_base + chunk_span * (0.58 + 0.30 * fraction)).round() as u8,
                                "clinvar",
                                format!(
                                    "ClinVar guard batch {} of {} · {}/{} candidate alleles",
                                    chunk_index + 1,
                                    chunk_count,
                                    processed,
                                    total
                                ),
                            )
                            .map_err(crate::DgwError::Tool)
                        },
                    )
                    .map_err(|error| error.to_string())?;
                let evaluated = saturation_inputs(
                    project,
                    selected_chunk,
                    &candidates,
                    &consequence,
                    &clinvar,
                )?;
                let mut chunk_request = request.clone();
                chunk_request.selected_variants = selected_chunk.to_vec();
                chunk_request.max_edits = selected_chunk.len() as u32;
                let plan = plan_saturation_optimizer(&current, focus, &chunk_request, &evaluated)
                    .map_err(|error| error.to_string())?;
                score_before += plan.score_before;
                excluded_positions = excluded_positions
                    .saturating_add(plan.exclusions.len().min(u32::MAX as usize) as u32);
                score_description = plan.score_description.clone();
                limitation = plan.limitation.clone();
                groups.extend(groups_from_plan(&plan));
                on_progress(
                    (chunk_base + chunk_span).round() as u8,
                    "reduce",
                    format!(
                        "Reduced candidate batch {} of {} to per-position winners",
                        chunk_index + 1,
                        chunk_count
                    ),
                )?;
            }
        }
        OptimizerMode::Conservative => {
            on_progress(
                12,
                "alleles",
                "Reading current and source allele-copy states".into(),
            )?;
            let current = project
                .effective_variants_for_track_at_loci(track_id, &request.selected_variants)
                .map_err(|error| error.to_string())?;
            let source = project
                .source_variants_at_loci(&request.selected_variants)
                .map_err(|error| error.to_string())?;
            let mut keys = BTreeMap::new();
            for variant in current.iter().chain(source.iter()) {
                keys.entry(variant.key.stable_key())
                    .or_insert_with(|| variant.key.clone());
            }
            let keys: Vec<_> = keys.into_values().collect();
            let need_consequence = request.objective == OptimizerObjective::PredictedImpactBurden
                && request.weights.impact > 0.0;
            let need_clinvar = request.direction == OptimizerDirection::Maximize;
            let consequence = if need_consequence {
                evaluation
                    .evaluate_device_signals_with_threads(
                        project,
                        &keys,
                        CONSEQUENCE_DEVICE_ID,
                        worker_threads,
                        |processed, total| {
                            if is_cancelled() {
                                return Err(crate::DgwError::Tool(
                                    OPTIMIZER_CANCELLED_MARKER.into(),
                                ));
                            }
                            on_progress(
                                18 + if total == 0 {
                                    24
                                } else {
                                    (processed * 24 / total) as u8
                                },
                                "consequences",
                                format!("Consequence Predictor · {processed}/{total} alleles"),
                            )
                            .map_err(crate::DgwError::Tool)
                        },
                    )
                    .map_err(|error| error.to_string())?
            } else {
                BTreeMap::new()
            };
            check_cancelled(&is_cancelled)?;
            let source_keys: Vec<_> = source.iter().map(|item| item.key.clone()).collect();
            let clinvar = if need_clinvar {
                evaluation
                    .evaluate_device_signals_with_threads(
                        project,
                        &source_keys,
                        CLINVAR_DEVICE_ID,
                        worker_threads,
                        |processed, total| {
                            if is_cancelled() {
                                return Err(crate::DgwError::Tool(
                                    OPTIMIZER_CANCELLED_MARKER.into(),
                                ));
                            }
                            on_progress(
                                45 + if total == 0 {
                                    25
                                } else {
                                    (processed * 25 / total) as u8
                                },
                                "clinvar",
                                format!("ClinVar guard · {processed}/{total} alleles"),
                            )
                            .map_err(crate::DgwError::Tool)
                        },
                    )
                    .map_err(|error| error.to_string())?
            } else {
                BTreeMap::new()
            };
            evaluated_candidates = keys.len().min(u32::MAX as usize) as u32;
            let evaluated = conservative_inputs(project, &keys, &consequence, &clinvar);
            on_progress(
                76,
                "reduce",
                "Ranking conservative source-allele candidates".into(),
            )?;
            let plan = plan_optimizer_with_evidence(&current, &source, focus, &request, &evaluated)
                .map_err(|error| error.to_string())?;
            score_before = plan.score_before;
            excluded_positions = plan.exclusions.len().min(u32::MAX as usize) as u32;
            score_description = plan.score_description.clone();
            limitation = plan.limitation.clone();
            groups.extend(groups_from_plan(&plan));
        }
    }

    check_cancelled(&is_cancelled)?;
    ensure_optimizer_track(
        project,
        track_id,
        expected_head_state_id,
        expected_bypassed_edit_ids,
    )?;
    groups.sort_by(|left, right| {
        right
            .improvement
            .partial_cmp(&left.improvement)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.source_variant.cmp(&right.source_variant))
    });
    let improving_positions = groups.len().min(u32::MAX as usize) as u32;
    let selected_groups: Vec<_> = groups
        .into_iter()
        .take(request.max_edits as usize)
        .collect();
    let changed_positions = selected_groups.len() as u32;
    let unchanged_or_tied_positions = considered_positions
        .saturating_sub(excluded_positions)
        .saturating_sub(improving_positions);
    let deferred_by_change_limit = improving_positions.saturating_sub(changed_positions);
    let score_delta: f64 = selected_groups.iter().map(|group| group.score_delta).sum();
    let changes: Vec<_> = selected_groups
        .into_iter()
        .flat_map(|group| group.changes)
        .collect();
    let generated_edits = changes.len().min(u32::MAX as usize) as u32;
    let no_op_reason = changes.is_empty().then(|| {
        "No selected position had an eligible allele that improved the requested objective."
            .to_owned()
    });
    let compound_layer_id = if changes.is_empty() {
        None
    } else {
        on_progress(
            90,
            "staging",
            format!(
                "Storing {} changes across {} optimized positions",
                generated_edits, changed_positions
            ),
        )?;
        let note = format!(
            "Genome Optimizer · {:?} · {:?} {:?} · {} positions",
            request.mode, request.direction, request.objective, changed_positions
        );
        Some(
            project
                .stage_compound_mutation_layer(
                    track_id,
                    expected_head_state_id,
                    "org.dgw.builtin.genome-optimizer",
                    changed_positions,
                    &changes,
                    Some(note),
                )
                .map_err(|error| error.to_string())?
                .id,
        )
    };
    Ok(OptimizerPreviewResult {
        mode: request.mode,
        direction: request.direction,
        considered_positions,
        evaluated_candidates,
        excluded_positions,
        improving_positions,
        unchanged_or_tied_positions,
        deferred_by_change_limit,
        changed_positions,
        generated_edits,
        score_before,
        score_after: score_before + score_delta,
        score_description,
        limitation,
        no_op_reason,
        candidate_comparisons_retained: 0,
        compound_layer_id,
    })
}

fn resolve_optimizer_request(
    project: &Project,
    track_id: &str,
    mut request: OptimizerRequest,
    selection: Option<&VariantSelection>,
    selection_limit: Option<u32>,
) -> std::result::Result<OptimizerRequest, String> {
    if let Some(selection) = selection {
        let limit = selection_limit
            .unwrap_or(MAX_SATURATION_POSITIONS as u32)
            .min(MAX_SATURATION_POSITIONS as u32)
            .max(1);
        let resolution = project
            .resolve_selection(selection, limit)
            .map_err(|error| error.to_string())?;
        if resolution.track_id != track_id {
            return Err("Genome Optimizer selection belongs to a different track".into());
        }
        if resolution.truncated {
            return Err(format!(
                "{} alleles are selected; Genome Optimizer accepts at most {} positions for this run",
                resolution.total, limit
            ));
        }
        request.selected_variants = resolution.variants;
    }
    if request.selected_variants.is_empty() {
        return Err("Select at least one active allele before running Genome Optimizer".into());
    }
    request.max_edits = request
        .max_edits
        .min(request.selected_variants.len().min(u32::MAX as usize) as u32);
    if request.selected_variants.len() > MAX_SATURATION_POSITIONS {
        return Err(format!(
            "Genome Optimizer accepts at most {MAX_SATURATION_POSITIONS} positions per run"
        ));
    }
    if request.max_edits == 0 || request.max_edits > MAX_OPTIMIZER_EDITS {
        return Err(format!(
            "Genome Optimizer changes must be between 1 and {MAX_OPTIMIZER_EDITS} positions"
        ));
    }
    Ok(request)
}

fn validate_evidence_contract(request: &OptimizerRequest) -> std::result::Result<(), String> {
    let has_consequence = request
        .evidence_device_ids
        .iter()
        .any(|device_id| device_id == CONSEQUENCE_DEVICE_ID);
    let has_clinvar = request
        .evidence_device_ids
        .iter()
        .any(|device_id| device_id == CLINVAR_DEVICE_ID);
    if request.mode == OptimizerMode::Saturation && (!has_consequence || !has_clinvar) {
        return Err(
            "Saturation requires applied, active Consequence Predictor and ClinVar devices".into(),
        );
    }
    if request.mode == OptimizerMode::Conservative
        && request.objective == OptimizerObjective::PredictedImpactBurden
        && request.weights.impact > 0.0
        && !has_consequence
    {
        return Err(
            "Weighted annotation burden requires applied, active Consequence Predictor".into(),
        );
    }
    if request.mode == OptimizerMode::Conservative
        && request.direction == OptimizerDirection::Maximize
        && !has_clinvar
    {
        return Err("Conservative Maximize requires an applied, active ClinVar guard".into());
    }
    Ok(())
}

fn ensure_optimizer_track(
    project: &Project,
    track_id: &str,
    expected_head_state_id: &str,
    expected_bypassed_edit_ids: &[String],
) -> std::result::Result<(), String> {
    let track = project.track(track_id).map_err(|error| error.to_string())?;
    if track.read_only {
        return Err("Duplicate the read-only source track before running Genome Optimizer".into());
    }
    if track.head_state_id != expected_head_state_id
        || track.bypassed_edit_ids != expected_bypassed_edit_ids
    {
        return Err(
            "the selected track changed while Genome Optimizer was running; run it again".into(),
        );
    }
    Ok(())
}

fn check_cancelled<C: Fn() -> bool>(is_cancelled: &C) -> std::result::Result<(), String> {
    if is_cancelled() {
        Err(OPTIMIZER_CANCELLED_MARKER.into())
    } else {
        Ok(())
    }
}

fn fraction(processed: usize, total: usize) -> f64 {
    if total == 0 {
        1.0
    } else {
        processed as f64 / total as f64
    }
}

fn optimizer_candidate_variants(selected: &[VariantKey]) -> Vec<VariantKey> {
    let mut candidates = BTreeMap::new();
    for source in selected {
        if source.reference.len() != 1
            || source.alternate.len() != 1
            || !matches!(
                source.reference.as_bytes()[0].to_ascii_uppercase(),
                b'A' | b'C' | b'G' | b'T'
            )
        {
            continue;
        }
        let reference = source.reference.as_bytes()[0].to_ascii_uppercase();
        for alternate in [b'A', b'C', b'G', b'T']
            .into_iter()
            .filter(|alternate| *alternate != reference)
        {
            let candidate = VariantKey {
                assembly: source.assembly.clone(),
                contig: source.contig.clone(),
                position: source.position,
                reference: char::from(reference).to_string(),
                alternate: char::from(alternate).to_string(),
            };
            candidates
                .entry(candidate.stable_key())
                .or_insert(candidate);
        }
    }
    candidates.into_values().collect()
}

fn groups_from_plan(plan: &OptimizerPlan) -> Vec<OptimizerGroup> {
    let mut grouped: BTreeMap<String, OptimizerGroup> = BTreeMap::new();
    for proposal in &plan.proposals {
        let key = proposal.source_variant.stable_key();
        let group = grouped.entry(key).or_insert_with(|| OptimizerGroup {
            source_variant: proposal.source_variant.clone(),
            changes: Vec::new(),
            score_delta: 0.0,
            improvement: 0.0,
        });
        group.changes.push(CompoundMutationChange {
            haplotype: proposal.haplotype,
            edit: proposal.edit.clone(),
        });
        group.score_delta += proposal.score_delta;
    }
    for group in grouped.values_mut() {
        group.improvement = group.score_delta.abs();
    }
    grouped.into_values().collect()
}

fn saturation_inputs(
    project: &Project,
    selected: &[VariantKey],
    candidates: &[VariantKey],
    consequence: &BTreeMap<VariantKey, crate::evaluation::BatchEvidenceSignal>,
    clinvar: &BTreeMap<VariantKey, crate::evaluation::BatchEvidenceSignal>,
) -> std::result::Result<Vec<SaturationAlleleInput>, String> {
    let mut evaluated = Vec::with_capacity(candidates.len());
    for source in selected {
        for candidate in candidates.iter().filter(|candidate| {
            candidate.assembly == source.assembly
                && candidate.contig == source.contig
                && candidate.position == source.position
                && candidate.reference.eq_ignore_ascii_case(&source.reference)
        }) {
            let consequence_signal = consequence.get(candidate).ok_or_else(|| {
                format!(
                    "Consequence Predictor omitted candidate {}",
                    candidate.display()
                )
            })?;
            let clinvar_signal = clinvar
                .get(candidate)
                .ok_or_else(|| format!("ClinVar omitted candidate {}", candidate.display()))?;
            let clinvar_evidence = evidence_from_batch_signal(
                &project.manifest().resource_bundle.clinvar.release,
                clinvar_signal,
            );
            evaluated.push(SaturationAlleleInput {
                source_variant: source.clone(),
                candidate_variant: candidate.clone(),
                consequence: evidence_from_batch_signal("Consequence Predictor", consequence_signal),
                clinvar: clinvar_evidence.clone(),
                evidence_statuses: BTreeMap::from([
                    (
                        CONSEQUENCE_DEVICE_ID.into(),
                        evidence_status_label(&consequence_signal.status).into(),
                    ),
                    (
                        CLINVAR_DEVICE_ID.into(),
                        evidence_status_label(&clinvar_signal.status).into(),
                    ),
                ]),
                exact_evidence_sources: (clinvar_signal.status == EvidenceStatus::Found)
                    .then(|| clinvar_evidence.source.clone())
                    .into_iter()
                    .collect(),
            });
        }
    }
    Ok(evaluated)
}

fn conservative_inputs(
    project: &Project,
    keys: &[VariantKey],
    consequence: &BTreeMap<VariantKey, crate::evaluation::BatchEvidenceSignal>,
    clinvar: &BTreeMap<VariantKey, crate::evaluation::BatchEvidenceSignal>,
) -> Vec<OptimizerAlleleEvidenceInput> {
    keys.iter()
        .map(|key| OptimizerAlleleEvidenceInput {
            variant: key.clone(),
            consequence: consequence
                .get(key)
                .map(|signal| evidence_from_batch_signal("Consequence Predictor", signal))
                .unwrap_or_else(|| not_computed_evidence("Consequence Predictor")),
            clinvar: clinvar
                .get(key)
                .map(|signal| {
                    evidence_from_batch_signal(
                        &project.manifest().resource_bundle.clinvar.release,
                        signal,
                    )
                })
                .unwrap_or_else(|| not_computed_evidence("ClinVar")),
        })
        .collect()
}

fn not_computed_evidence(source: &str) -> EvidenceResult {
    EvidenceResult {
        source: source.into(),
        status: EvidenceStatus::NotComputed,
        records: Vec::new(),
        message: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn candidate_generation_deduplicates_multiallelic_source_loci() {
        let first = VariantKey {
            assembly: "GRCh37".into(),
            contig: "1".into(),
            position: 100,
            reference: "A".into(),
            alternate: "C".into(),
        };
        let candidates = optimizer_candidate_variants(&[
            first.clone(),
            VariantKey {
                alternate: "G".into(),
                ..first
            },
        ]);
        assert_eq!(candidates.len(), 3);
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.alternate.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["C", "G", "T"])
        );
    }

    #[test]
    fn cancellation_marker_survives_wrapped_errors() {
        assert!(optimizer_error_is_cancelled(&format!(
            "external tool failed: {OPTIMIZER_CANCELLED_MARKER}"
        )));
    }
}
