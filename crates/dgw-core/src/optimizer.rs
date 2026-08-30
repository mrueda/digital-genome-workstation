use crate::error::{DgwError, Result};
use crate::model::{
    EditKind, EffectiveVariant, EvidenceResult, EvidenceStatus, FocusContext, Haplotype, VariantKey,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

/// A run can propose only a small, reviewable set of edit operations.
pub const MAX_OPTIMIZER_EDITS: u32 = 100;
pub const MAX_SATURATION_POSITIONS: usize = 100;

pub const ADDITIVE_SCORE_LIMITATION: &str = "Scores are additive sums of independently scored allele copies in the analyzed scope. Interactions among nearby variants, phase-dependent combined consequences, penetrance, and whole-genome effects are not modeled.";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OptimizerObjective {
    AlternateAlleleBurden,
    PredictedImpactBurden,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OptimizerDirection {
    Minimize,
    Maximize,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OptimizerMode {
    #[default]
    Conservative,
    Saturation,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerWeights {
    pub impact: f64,
    pub clinvar: f64,
    pub source_evidence: f64,
}

impl Default for OptimizerWeights {
    fn default() -> Self {
        Self {
            impact: 1.0,
            clinvar: 0.0,
            source_evidence: 0.25,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerRequest {
    #[serde(default)]
    pub mode: OptimizerMode,
    pub objective: OptimizerObjective,
    pub direction: OptimizerDirection,
    pub max_edits: u32,
    #[serde(default)]
    pub weights: OptimizerWeights,
    #[serde(default)]
    pub selected_variants: Vec<VariantKey>,
    #[serde(default)]
    pub evidence_device_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerEvidence {
    /// Normalized SnpEff ANN impact signal: HIGH=1, MODERATE=0.67,
    /// LOW=0.33, and MODIFIER=0.1.
    pub impact_signal: f64,
    pub impact_label: Option<String>,
    /// A conservative normalized signal derived only from a recognized CLNSIG
    /// classification. Unrecognized and missing classifications contribute 0.
    pub clinvar_signal: f64,
    pub clinvar_classification: Option<String>,
    /// 1 only when the exact allele is present in the immutable source input.
    pub source_evidence_signal: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerScoreComponents {
    pub alternate_allele: f64,
    pub weighted_impact: f64,
    pub weighted_clinvar: f64,
    pub weighted_source_evidence: f64,
    pub objective_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerProposal {
    pub source_variant: VariantKey,
    pub haplotype: Haplotype,
    pub edit: EditKind,
    pub evidence: OptimizerEvidence,
    pub score_components: OptimizerScoreComponents,
    /// Contribution removed by a replacement-style SetAllele operation.
    pub replaced_score_components: Option<OptimizerScoreComponents>,
    pub score_before_contribution: f64,
    pub score_after_contribution: f64,
    pub score_delta: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerExclusion {
    pub source_variant: VariantKey,
    pub haplotype: Haplotype,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaturationAlleleInput {
    pub source_variant: VariantKey,
    pub candidate_variant: VariantKey,
    pub snpeff: EvidenceResult,
    pub clinvar: EvidenceResult,
    pub evidence_statuses: BTreeMap<String, String>,
    pub exact_evidence_sources: Vec<String>,
}

/// Exact-allele evidence prepared by the host from the pinned live devices.
/// Imported VCF INFO is deliberately absent from this contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerAlleleEvidenceInput {
    pub variant: VariantKey,
    pub snpeff: EvidenceResult,
    pub clinvar: EvidenceResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerCandidateComparison {
    pub source_variant: VariantKey,
    pub candidate_variant: VariantKey,
    pub current: bool,
    pub selected: bool,
    pub comparable: bool,
    pub evidence: OptimizerEvidence,
    pub score_components: OptimizerScoreComponents,
    pub evidence_statuses: BTreeMap<String, String>,
    pub exact_evidence_sources: Vec<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerPlan {
    pub request: OptimizerRequest,
    pub focus: FocusContext,
    pub proposals: Vec<OptimizerProposal>,
    pub exclusions: Vec<OptimizerExclusion>,
    pub score_before: f64,
    pub score_after: f64,
    pub considered_variants: u32,
    pub considered_source_variants: u32,
    pub eligible_candidates: u32,
    #[serde(default)]
    pub candidate_comparisons: Vec<OptimizerCandidateComparison>,
    pub no_op_reason: Option<String>,
    pub score_description: String,
    pub limitation: String,
    pub constraints: Vec<String>,
}

#[derive(Debug)]
struct Candidate {
    proposal: OptimizerProposal,
    improvement: f64,
}

#[derive(Debug)]
struct SaturationGroup {
    source_variant: VariantKey,
    proposals: Vec<OptimizerProposal>,
    improvement: f64,
    score_delta: f64,
}

/// Build a bounded, non-mutating edit plan for a focused region.
///
/// `source` must be the effective variants of the protected source state;
/// `current` is the effective state of the candidate track. The function never
/// creates an allele that is absent from `source`.
pub fn plan_optimizer(
    current: &[EffectiveVariant],
    source: &[EffectiveVariant],
    focus: &FocusContext,
    request: &OptimizerRequest,
) -> Result<OptimizerPlan> {
    plan_optimizer_with_evidence(current, source, focus, request, &[])
}

pub fn plan_optimizer_with_evidence(
    current: &[EffectiveVariant],
    source: &[EffectiveVariant],
    focus: &FocusContext,
    request: &OptimizerRequest,
    evaluated_alleles: &[OptimizerAlleleEvidenceInput],
) -> Result<OptimizerPlan> {
    validate_request(focus, request)?;
    if request.mode != OptimizerMode::Conservative {
        return Err(DgwError::InvalidEdit(
            "saturation mode requires evaluated candidate alleles".into(),
        ));
    }
    validate_unique_keys("current", current)?;
    validate_unique_keys("source", source)?;
    let evidence_by_key: BTreeMap<&VariantKey, &OptimizerAlleleEvidenceInput> = evaluated_alleles
        .iter()
        .map(|evidence| (&evidence.variant, evidence))
        .collect();
    validate_live_evidence(current, source, request, &evidence_by_key)?;

    let source_by_key: BTreeMap<&VariantKey, &EffectiveVariant> = source
        .iter()
        .map(|variant| (&variant.key, variant))
        .collect();
    let current_by_key: BTreeMap<&VariantKey, &EffectiveVariant> = current
        .iter()
        .map(|variant| (&variant.key, variant))
        .collect();
    let source_keys: BTreeSet<&VariantKey> = source_by_key.keys().copied().collect();

    let focused_current: Vec<&EffectiveVariant> = current
        .iter()
        .filter(|variant| is_selected(&variant.key, focus, request))
        .collect();
    let considered_source_variants = source
        .iter()
        .filter(|variant| is_selected(&variant.key, focus, request))
        .count() as u32;
    let score_before = score_state(&focused_current, &source_keys, request, &evidence_by_key);
    let mut candidates = Vec::new();
    let mut exclusions = Vec::new();

    match request.direction {
        OptimizerDirection::Minimize => {
            collect_minimize_candidates(
                &focused_current,
                &source_by_key,
                request,
                &evidence_by_key,
                &mut candidates,
                &mut exclusions,
            );
        }
        OptimizerDirection::Maximize => {
            collect_maximize_candidates(
                current,
                source,
                &current_by_key,
                focus,
                request,
                &evidence_by_key,
                &mut candidates,
                &mut exclusions,
            );
        }
    }

    let eligible_candidates = candidates.len() as u32;
    candidates.sort_by(compare_candidates);
    let proposals: Vec<OptimizerProposal> = candidates
        .into_iter()
        .take(request.max_edits as usize)
        .map(|candidate| candidate.proposal)
        .collect();
    let delta: f64 = proposals.iter().map(|proposal| proposal.score_delta).sum();
    let score_after = clean_zero(score_before + delta);
    let no_op_reason = if proposals.is_empty() {
        Some(no_op_reason(
            request.direction,
            eligible_candidates,
            considered_source_variants,
            &exclusions,
        ))
    } else {
        None
    };

    Ok(OptimizerPlan {
        request: request.clone(),
        focus: focus.clone(),
        proposals,
        exclusions,
        score_before,
        score_after,
        considered_variants: focused_current.len() as u32,
        considered_source_variants,
        eligible_candidates,
        candidate_comparisons: Vec::new(),
        no_op_reason,
        score_description: score_description(request).into(),
        limitation: ADDITIVE_SCORE_LIMITATION.into(),
        constraints: vec![
            "Conservative candidates are restricted to exact alleles present in the original source input. Saturation candidates are exact non-reference SNV bases evaluated live."
                .into(),
            "Imported VCF annotations are ignored; scores use only exact-allele evidence from the pinned devices."
                .into(),
            "ClinVar Pathogenic/Likely pathogenic exact matches are never eligible optimizer targets."
                .into(),
            format!(
                "One run emits at most {} reversible edit operations.",
                request.max_edits
            ),
            "Unphased source alleles remain unphased in proposed edits.".into(),
        ],
    })
}

/// Compare all three non-reference SNV alleles at each selected active position.
/// Candidate evidence is prepared by the host so the pure planner remains
/// deterministic and does not execute external tools.
pub fn plan_saturation_optimizer(
    current: &[EffectiveVariant],
    focus: &FocusContext,
    request: &OptimizerRequest,
    evaluated_candidates: &[SaturationAlleleInput],
) -> Result<OptimizerPlan> {
    validate_request(focus, request)?;
    if request.mode != OptimizerMode::Saturation {
        return Err(DgwError::InvalidEdit(
            "saturation planning requires saturation mode".into(),
        ));
    }
    validate_unique_keys("current", current)?;

    let current_by_key: BTreeMap<&VariantKey, &EffectiveVariant> = current
        .iter()
        .map(|variant| (&variant.key, variant))
        .collect();
    let mut selected = BTreeSet::new();
    for key in &request.selected_variants {
        if !selected.insert(key.clone()) {
            return Err(DgwError::InvalidEdit(format!(
                "saturation selection contains duplicate allele {}",
                key.display()
            )));
        }
    }
    let mut inputs_by_source: BTreeMap<&VariantKey, Vec<&SaturationAlleleInput>> = BTreeMap::new();
    for input in evaluated_candidates {
        inputs_by_source
            .entry(&input.source_variant)
            .or_default()
            .push(input);
    }

    let mut comparisons = Vec::new();
    let mut groups = Vec::new();
    let mut exclusions = Vec::new();
    let mut score_before = 0.0;

    for selected_key in &request.selected_variants {
        let Some(current_variant) = current_by_key.get(selected_key).copied() else {
            exclusions.push(saturation_exclusion(
                selected_key,
                None,
                "The selected allele is no longer active on this track.",
            ));
            continue;
        };
        let haplotypes = active_haplotypes(current_variant);
        if haplotypes.is_empty() {
            exclusions.push(saturation_exclusion(
                selected_key,
                None,
                "The selected allele has no active chromosome-copy placement.",
            ));
            continue;
        }
        if !is_canonical_snv(selected_key) {
            exclusions.push(saturation_exclusion(
                selected_key,
                haplotypes.first().copied(),
                "Saturation mode currently supports canonical A/C/G/T SNVs only.",
            ));
            continue;
        }
        let inputs = inputs_by_source
            .get(selected_key)
            .cloned()
            .unwrap_or_default();
        let mut unique_alternates = BTreeSet::new();
        let valid_inputs: Vec<&SaturationAlleleInput> = inputs
            .into_iter()
            .filter(|input| {
                let key = &input.candidate_variant;
                key.assembly == selected_key.assembly
                    && key.contig == selected_key.contig
                    && key.position == selected_key.position
                    && key.reference.eq_ignore_ascii_case(&selected_key.reference)
                    && is_canonical_snv(key)
                    && unique_alternates.insert(key.alternate.to_ascii_uppercase())
            })
            .collect();
        if valid_inputs.len() != 3 {
            exclusions.push(saturation_exclusion(
                selected_key,
                haplotypes.first().copied(),
                "The host did not provide all three unique non-REF SNV candidates.",
            ));
            continue;
        }

        let mut local = Vec::with_capacity(3);
        for input in valid_inputs {
            if matches!(
                input.snpeff.status,
                EvidenceStatus::Error
                    | EvidenceStatus::ResourceUnavailable
                    | EvidenceStatus::NotComputed
            ) {
                return Err(DgwError::InvalidEdit(format!(
                    "SnpEff could not evaluate saturation candidate {} ({:?})",
                    input.candidate_variant.display(),
                    input.snpeff.status
                )));
            }
            ensure_completed_clinvar(&input.candidate_variant, &input.clinvar)?;
            let (evidence, score_components) =
                score_live_evidence(Some(&input.snpeff), Some(&input.clinvar), false, request);
            let snpeff_found = input.snpeff.status == EvidenceStatus::Found;
            let comparable = snpeff_found && evidence.impact_label.is_some();
            let guarded = clinvar_is_pathogenic_or_likely_pathogenic(&input.clinvar);
            local.push((input, evidence, score_components, comparable, guarded));
        }
        if local.iter().any(|(_, _, _, comparable, _)| !comparable) {
            for (input, evidence, score_components, comparable, guarded) in local {
                comparisons.push(OptimizerCandidateComparison {
                    source_variant: selected_key.clone(),
                    candidate_variant: input.candidate_variant.clone(),
                    current: input
                        .candidate_variant
                        .alternate
                        .eq_ignore_ascii_case(&selected_key.alternate),
                    selected: false,
                    comparable,
                    evidence,
                    score_components,
                    evidence_statuses: input.evidence_statuses.clone(),
                    exact_evidence_sources: input.exact_evidence_sources.clone(),
                    note: if !comparable {
                        Some(
                            "SnpEff did not return a recognized comparable impact category.".into(),
                        )
                    } else if guarded {
                        Some(
                            "Excluded by the fixed ClinVar Pathogenic/Likely pathogenic guard."
                                .into(),
                        )
                    } else {
                        None
                    },
                });
            }
            exclusions.push(saturation_exclusion(
                selected_key,
                haplotypes.first().copied(),
                "At least one possible ALT lacks a recognized SnpEff impact, so this position cannot be compared safely.",
            ));
            continue;
        }

        let current_index = local
            .iter()
            .position(|(input, _, _, _, _)| {
                input
                    .candidate_variant
                    .alternate
                    .eq_ignore_ascii_case(&selected_key.alternate)
            })
            .ok_or_else(|| {
                DgwError::InvalidEdit(format!(
                    "saturation candidates omit the current ALT for {}",
                    selected_key.display()
                ))
            })?;
        let winner_index = local
            .iter()
            .enumerate()
            .filter(|(_, candidate)| !candidate.4)
            .min_by(|(left_index, left), (right_index, right)| {
                compare_saturation_scores(
                    request.direction,
                    left.2.objective_score,
                    right.2.objective_score,
                    *left_index == current_index,
                    *right_index == current_index,
                    &left.0.candidate_variant,
                    &right.0.candidate_variant,
                )
            })
            .map(|(index, _)| index)
            .ok_or_else(|| {
                DgwError::InvalidEdit(format!(
                    "every saturation candidate for {} is excluded by the fixed ClinVar guard",
                    selected_key.display()
                ))
            })?;
        let before_per_copy = local[current_index].2.objective_score;
        let after_per_copy = local[winner_index].2.objective_score;
        let copies = haplotypes.len() as f64;
        score_before += before_per_copy * copies;

        for (index, (input, evidence, score_components, comparable, guarded)) in
            local.iter().enumerate()
        {
            comparisons.push(OptimizerCandidateComparison {
                source_variant: selected_key.clone(),
                candidate_variant: input.candidate_variant.clone(),
                current: index == current_index,
                selected: index == winner_index && !*guarded,
                comparable: *comparable,
                evidence: evidence.clone(),
                score_components: score_components.clone(),
                evidence_statuses: input.evidence_statuses.clone(),
                exact_evidence_sources: input.exact_evidence_sources.clone(),
                note: (*guarded).then(|| {
                    "Excluded by the fixed ClinVar Pathogenic/Likely pathogenic guard.".into()
                }),
            });
        }

        let improvement_per_copy = match request.direction {
            OptimizerDirection::Minimize => before_per_copy - after_per_copy,
            OptimizerDirection::Maximize => after_per_copy - before_per_copy,
        };
        if winner_index == current_index || improvement_per_copy <= 0.0 {
            exclusions.push(saturation_exclusion(
                selected_key,
                haplotypes.first().copied(),
                "The current ALT already has the best comparable score at this position.",
            ));
            continue;
        }

        let winner = &local[winner_index];
        let score_delta_per_copy = after_per_copy - before_per_copy;
        let proposals = haplotypes
            .into_iter()
            .map(|haplotype| OptimizerProposal {
                source_variant: selected_key.clone(),
                haplotype,
                edit: EditKind::SetAllele {
                    key: winner.0.candidate_variant.clone(),
                    source_key: Some(selected_key.clone()),
                },
                evidence: winner.1.clone(),
                score_components: winner.2.clone(),
                replaced_score_components: Some(local[current_index].2.clone()),
                score_before_contribution: before_per_copy,
                score_after_contribution: after_per_copy,
                score_delta: score_delta_per_copy,
                rationale: format!(
                    "Choose the {}-scoring non-reference SNV ALT from the complete three-base saturation set at this position.",
                    if request.direction == OptimizerDirection::Minimize { "lowest" } else { "highest" }
                ),
            })
            .collect();
        groups.push(SaturationGroup {
            source_variant: selected_key.clone(),
            proposals,
            improvement: improvement_per_copy * copies,
            score_delta: score_delta_per_copy * copies,
        });
    }

    groups.sort_by(|left, right| {
        right
            .improvement
            .partial_cmp(&left.improvement)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.source_variant.cmp(&right.source_variant))
    });
    let eligible_candidates = comparisons
        .iter()
        .filter(|comparison| comparison.comparable)
        .count() as u32;
    let mut proposals = Vec::new();
    let mut applied_delta = 0.0;
    for group in groups.into_iter().take(request.max_edits as usize) {
        applied_delta += group.score_delta;
        proposals.extend(group.proposals);
    }
    let no_op_reason = proposals.is_empty().then(|| {
        if comparisons.is_empty() {
            "No selected positions had a complete comparable saturation set; review the exclusions."
                .into()
        } else {
            "The current ALTs already have the best comparable scores, or the edit limit excludes the available genotype changes."
                .into()
        }
    });

    Ok(OptimizerPlan {
        request: request.clone(),
        focus: focus.clone(),
        proposals,
        exclusions,
        score_before: clean_zero(score_before),
        score_after: clean_zero(score_before + applied_delta),
        considered_variants: selected.len() as u32,
        considered_source_variants: selected.len() as u32,
        eligible_candidates,
        candidate_comparisons: comparisons,
        no_op_reason,
        score_description: score_description(request).into(),
        limitation: ADDITIVE_SCORE_LIMITATION.into(),
        constraints: vec![
            "Candidates are restricted to the three non-reference SNV bases at each explicitly selected imported VCF position, across any chromosome.".into(),
            "Only normalized SnpEff impact contributes to the comparable saturation score; database absence never lowers the score.".into(),
            "All active chromosome-copy placements at a position are changed together; a bounded run never emits a partial homozygous replacement.".into(),
            format!("One run changes at most {} selected positions; a homozygous position may emit two internal mutation blocks.", request.max_edits),
        ],
    })
}

fn compare_saturation_scores(
    direction: OptimizerDirection,
    left_score: f64,
    right_score: f64,
    left_current: bool,
    right_current: bool,
    left_key: &VariantKey,
    right_key: &VariantKey,
) -> Ordering {
    let score_order = match direction {
        OptimizerDirection::Minimize => left_score.partial_cmp(&right_score),
        OptimizerDirection::Maximize => right_score.partial_cmp(&left_score),
    }
    .unwrap_or(Ordering::Equal);
    score_order
        .then_with(|| right_current.cmp(&left_current))
        .then_with(|| left_key.cmp(right_key))
}

fn saturation_exclusion(
    source_variant: &VariantKey,
    haplotype: Option<Haplotype>,
    reason: &str,
) -> OptimizerExclusion {
    OptimizerExclusion {
        source_variant: source_variant.clone(),
        haplotype: haplotype.unwrap_or(Haplotype::Unphased),
        reason: reason.into(),
    }
}

fn is_canonical_snv(key: &VariantKey) -> bool {
    key.reference.len() == 1
        && key.alternate.len() == 1
        && matches!(
            key.reference.as_bytes()[0].to_ascii_uppercase(),
            b'A' | b'C' | b'G' | b'T'
        )
        && matches!(
            key.alternate.as_bytes()[0].to_ascii_uppercase(),
            b'A' | b'C' | b'G' | b'T'
        )
        && !key.reference.eq_ignore_ascii_case(&key.alternate)
}

fn validate_request(focus: &FocusContext, request: &OptimizerRequest) -> Result<()> {
    if focus.contig.trim().is_empty() {
        return Err(DgwError::InvalidEdit(
            "optimizer focus contig cannot be empty".into(),
        ));
    }
    if focus.start == 0 || focus.end < focus.start {
        return Err(DgwError::InvalidEdit(
            "optimizer focus must use a valid 1-based inclusive interval".into(),
        ));
    }
    if request.max_edits == 0 || request.max_edits > MAX_OPTIMIZER_EDITS {
        return Err(DgwError::InvalidEdit(format!(
            "optimizer max_edits must be between 1 and {MAX_OPTIMIZER_EDITS}"
        )));
    }
    if request.selected_variants.len() > MAX_SATURATION_POSITIONS {
        return Err(DgwError::InvalidEdit(format!(
            "optimizer accepts at most {MAX_SATURATION_POSITIONS} selected positions per run"
        )));
    }
    let mut selected = BTreeSet::new();
    if request
        .selected_variants
        .iter()
        .any(|variant| !selected.insert(variant.stable_key()))
    {
        return Err(DgwError::InvalidEdit(
            "optimizer selection contains duplicate alleles".into(),
        ));
    }
    for (name, weight) in [
        ("impact", request.weights.impact),
        ("ClinVar", request.weights.clinvar),
        ("source evidence", request.weights.source_evidence),
    ] {
        if !weight.is_finite() || !(0.0..=1_000.0).contains(&weight) {
            return Err(DgwError::InvalidEdit(format!(
                "optimizer {name} weight must be finite and between 0 and 1000"
            )));
        }
    }
    if request.objective == OptimizerObjective::PredictedImpactBurden
        && request.weights.impact == 0.0
        && request.weights.clinvar == 0.0
        && request.weights.source_evidence == 0.0
    {
        return Err(DgwError::InvalidEdit(
            "predicted impact burden requires at least one positive weight".into(),
        ));
    }
    if request.mode == OptimizerMode::Conservative
        && request.objective == OptimizerObjective::PredictedImpactBurden
    {
        return Err(DgwError::InvalidEdit(
            "weighted biological impact cannot treat REF as a zero-burden allele; use Saturation to compare live-evaluated ALT candidates, or use ALT-copy count explicitly as a reference-distance objective"
                .into(),
        ));
    }
    if request.weights.clinvar != 0.0 {
        return Err(DgwError::InvalidEdit(
            "ClinVar is a fixed optimizer guard, not a burden weight; set its legacy weight to 0"
                .into(),
        ));
    }
    if request.mode == OptimizerMode::Saturation {
        if request.objective != OptimizerObjective::PredictedImpactBurden {
            return Err(DgwError::InvalidEdit(
                "saturation mode requires the weighted annotation burden objective".into(),
            ));
        }
        if request.selected_variants.is_empty() {
            return Err(DgwError::InvalidEdit(
                "select one or more active SNV positions for saturation mode".into(),
            ));
        }
        if request.weights.source_evidence != 0.0 {
            return Err(DgwError::InvalidEdit(
                "saturation mode uses comparable SnpEff impact only; ClinVar absence and source membership cannot contribute to its score".into(),
            ));
        }
        if request.weights.impact <= 0.0 {
            return Err(DgwError::InvalidEdit(
                "saturation mode requires a positive SnpEff impact weight".into(),
            ));
        }
    }
    Ok(())
}

fn validate_live_evidence<'a>(
    current: &[EffectiveVariant],
    source: &[EffectiveVariant],
    request: &OptimizerRequest,
    evidence_by_key: &BTreeMap<&'a VariantKey, &'a OptimizerAlleleEvidenceInput>,
) -> Result<()> {
    let selected_current: Vec<&EffectiveVariant> = current
        .iter()
        .filter(|variant| {
            request.selected_variants.is_empty() || selection_contains_locus(request, &variant.key)
        })
        .collect();
    let selected_source: Vec<&EffectiveVariant> = source
        .iter()
        .filter(|variant| {
            request.selected_variants.is_empty() || selection_contains_locus(request, &variant.key)
        })
        .collect();
    if request.objective == OptimizerObjective::PredictedImpactBurden
        && request.weights.impact > 0.0
    {
        let mut required = BTreeSet::new();
        for variant in selected_current.iter().chain(selected_source.iter()) {
            if required.insert(variant.key.stable_key()) {
                let input = evidence_by_key.get(&variant.key).copied().ok_or_else(|| {
                    DgwError::InvalidEdit(format!(
                        "live SnpEff evidence is missing for {}",
                        variant.key.display()
                    ))
                })?;
                ensure_comparable_snpeff(&variant.key, &input.snpeff)?;
            }
        }
    }
    if request.direction == OptimizerDirection::Maximize {
        for variant in selected_source {
            if current.iter().any(|candidate| {
                candidate.key == variant.key && !active_haplotypes(candidate).is_empty()
            }) {
                continue;
            }
            let input = evidence_by_key.get(&variant.key).copied().ok_or_else(|| {
                DgwError::InvalidEdit(format!(
                    "the fixed ClinVar guard has not evaluated {}",
                    variant.key.display()
                ))
            })?;
            ensure_completed_clinvar(&variant.key, &input.clinvar)?;
        }
    }
    Ok(())
}

fn ensure_comparable_snpeff(key: &VariantKey, evidence: &EvidenceResult) -> Result<()> {
    if evidence.status != EvidenceStatus::Found {
        return Err(DgwError::InvalidEdit(format!(
            "SnpEff did not return comparable exact-allele evidence for {} ({:?})",
            key.display(),
            evidence.status
        )));
    }
    if impact_signal_from_evidence(evidence).1.is_none() {
        return Err(DgwError::InvalidEdit(format!(
            "SnpEff returned no recognized impact category for {}",
            key.display()
        )));
    }
    Ok(())
}

fn ensure_completed_clinvar(key: &VariantKey, evidence: &EvidenceResult) -> Result<()> {
    if !matches!(
        evidence.status,
        EvidenceStatus::Found | EvidenceStatus::NoExactMatch
    ) {
        return Err(DgwError::InvalidEdit(format!(
            "the fixed ClinVar guard could not evaluate {} ({:?})",
            key.display(),
            evidence.status
        )));
    }
    Ok(())
}

fn validate_unique_keys(label: &str, variants: &[EffectiveVariant]) -> Result<()> {
    let mut keys = BTreeSet::new();
    for variant in variants {
        if !keys.insert(&variant.key) {
            return Err(DgwError::InvalidEdit(format!(
                "optimizer {label} variants contain duplicate allele {}",
                variant.key.display()
            )));
        }
    }
    Ok(())
}

fn collect_minimize_candidates(
    current: &[&EffectiveVariant],
    source_by_key: &BTreeMap<&VariantKey, &EffectiveVariant>,
    request: &OptimizerRequest,
    evidence_by_key: &BTreeMap<&VariantKey, &OptimizerAlleleEvidenceInput>,
    candidates: &mut Vec<Candidate>,
    exclusions: &mut Vec<OptimizerExclusion>,
) {
    for variant in current {
        if !source_by_key.contains_key(&variant.key) {
            continue;
        }
        let (evidence, components) = score_variant(&variant.key, true, request, evidence_by_key);
        for haplotype in active_haplotypes(variant) {
            if components.objective_score <= 0.0 {
                exclusions.push(OptimizerExclusion {
                    source_variant: variant.key.clone(),
                    haplotype,
                    reason:
                        "This allele copy has zero score under the selected objective and weights."
                            .into(),
                });
                continue;
            }
            let score_delta = -components.objective_score;
            candidates.push(Candidate {
                improvement: -score_delta,
                proposal: OptimizerProposal {
                    source_variant: variant.key.clone(),
                    haplotype,
                    edit: EditKind::RestoreReference {
                        source_key: variant.key.clone(),
                    },
                    evidence: evidence.clone(),
                    score_components: components.clone(),
                    replaced_score_components: None,
                    score_before_contribution: components.objective_score,
                    score_after_contribution: 0.0,
                    score_delta,
                    rationale: "Restore one active source allele copy to the reference sequence."
                        .into(),
                },
            });
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_maximize_candidates(
    current: &[EffectiveVariant],
    source: &[EffectiveVariant],
    current_by_key: &BTreeMap<&VariantKey, &EffectiveVariant>,
    focus: &FocusContext,
    request: &OptimizerRequest,
    evidence_by_key: &BTreeMap<&VariantKey, &OptimizerAlleleEvidenceInput>,
    candidates: &mut Vec<Candidate>,
    exclusions: &mut Vec<OptimizerExclusion>,
) {
    let source_keys: BTreeSet<&VariantKey> = source.iter().map(|variant| &variant.key).collect();
    for source_variant in source
        .iter()
        .filter(|variant| is_selected(&variant.key, focus, request))
    {
        // Reintroduction is deliberately allele-level. A partially present
        // genotype is not rewritten because its copy/phase intent is ambiguous.
        if current_by_key
            .get(&source_variant.key)
            .is_some_and(|variant| !active_haplotypes(variant).is_empty())
        {
            continue;
        }

        let candidate_evidence = evidence_by_key
            .get(&source_variant.key)
            .copied()
            .expect("maximize candidates were validated for exact ClinVar evidence");
        if clinvar_is_pathogenic_or_likely_pathogenic(&candidate_evidence.clinvar) {
            for haplotype in active_haplotypes(source_variant) {
                exclusions.push(OptimizerExclusion {
                    source_variant: source_variant.key.clone(),
                    haplotype,
                    reason: "ClinVar reports an exact Pathogenic/Likely pathogenic match; the fixed optimizer guard excludes this target."
                        .into(),
                });
            }
            continue;
        }
        let (evidence, components) =
            score_variant(&source_variant.key, true, request, evidence_by_key);
        for haplotype in active_haplotypes(source_variant) {
            let replacements: Vec<&EffectiveVariant> = current
                .iter()
                .filter(|variant| {
                    variant.source_key.as_ref() == Some(&source_variant.key)
                        && is_active_on(variant, haplotype)
                })
                .collect();
            if replacements.len() > 1 {
                exclusions.push(OptimizerExclusion {
                    source_variant: source_variant.key.clone(),
                    haplotype,
                    reason: "More than one active replacement refers to this source allele copy; the planner will not guess which edit to reverse."
                        .into(),
                });
                continue;
            }
            let replacement = replacements.first().copied();
            if let Some(overlap) = blocking_overlap(
                current,
                &source_variant.key,
                haplotype,
                replacement.map(|variant| &variant.key),
            ) {
                exclusions.push(OptimizerExclusion {
                    source_variant: source_variant.key.clone(),
                    haplotype,
                    reason: format!(
                        "An active allele {} overlaps this source allele on the same genome copy.",
                        overlap.display()
                    ),
                });
                continue;
            }

            let replaced_components = replacement.map(|variant| {
                score_variant(
                    &variant.key,
                    source_keys.contains(&variant.key),
                    request,
                    evidence_by_key,
                )
                .1
            });
            let before = replaced_components
                .as_ref()
                .map_or(0.0, |score| score.objective_score);
            let after = components.objective_score;
            let score_delta = after - before;
            if score_delta <= 0.0 {
                exclusions.push(OptimizerExclusion {
                    source_variant: source_variant.key.clone(),
                    haplotype,
                    reason: "Reintroducing this source allele copy would not increase the selected additive score."
                        .into(),
                });
                continue;
            }

            let replacement_key = replacement.map(|variant| variant.key.clone());
            let rationale = if replacement_key.is_some() {
                "Replace an edited allele with the exact allele recorded in the original source."
            } else {
                "Reintroduce one allele copy recorded in the original source."
            };
            candidates.push(Candidate {
                improvement: score_delta,
                proposal: OptimizerProposal {
                    source_variant: source_variant.key.clone(),
                    haplotype,
                    edit: EditKind::SetAllele {
                        key: source_variant.key.clone(),
                        source_key: replacement_key,
                    },
                    evidence: evidence.clone(),
                    score_components: components.clone(),
                    replaced_score_components: replaced_components,
                    score_before_contribution: before,
                    score_after_contribution: after,
                    score_delta,
                    rationale: rationale.into(),
                },
            });
        }
    }
}

fn blocking_overlap<'a>(
    current: &'a [EffectiveVariant],
    candidate: &VariantKey,
    haplotype: Haplotype,
    replacement: Option<&VariantKey>,
) -> Option<&'a VariantKey> {
    // The core edit validator intentionally treats unphased records
    // independently instead of assigning them to a genome copy.
    if haplotype == Haplotype::Unphased {
        return None;
    }
    current
        .iter()
        .filter(|variant| replacement != Some(&variant.key))
        .find(|variant| is_active_on(variant, haplotype) && overlaps(candidate, &variant.key))
        .map(|variant| &variant.key)
}

fn overlaps(left: &VariantKey, right: &VariantKey) -> bool {
    left.contig == right.contig && left.position <= right.end() && right.position <= left.end()
}

fn is_in_focus(key: &VariantKey, focus: &FocusContext) -> bool {
    key.contig == focus.contig && key.position <= focus.end && key.end() >= focus.start
}

fn selection_contains_locus(request: &OptimizerRequest, key: &VariantKey) -> bool {
    request.selected_variants.iter().any(|selected| {
        selected.assembly == key.assembly
            && selected.contig == key.contig
            && selected.position == key.position
            && selected.reference.eq_ignore_ascii_case(&key.reference)
    })
}

fn is_selected(key: &VariantKey, focus: &FocusContext, request: &OptimizerRequest) -> bool {
    if request.selected_variants.is_empty() {
        is_in_focus(key, focus)
    } else {
        selection_contains_locus(request, key)
    }
}

fn active_haplotypes(variant: &EffectiveVariant) -> Vec<Haplotype> {
    let mut haplotypes = Vec::with_capacity(3);
    if variant.haplotype1_alt {
        haplotypes.push(Haplotype::One);
    }
    if variant.haplotype2_alt {
        haplotypes.push(Haplotype::Two);
    }
    if variant.unphased_alt {
        haplotypes.push(Haplotype::Unphased);
    }
    haplotypes
}

fn is_active_on(variant: &EffectiveVariant, haplotype: Haplotype) -> bool {
    match haplotype {
        Haplotype::One => variant.haplotype1_alt,
        Haplotype::Two => variant.haplotype2_alt,
        Haplotype::Unphased => variant.unphased_alt,
    }
}

fn score_state(
    variants: &[&EffectiveVariant],
    source_keys: &BTreeSet<&VariantKey>,
    request: &OptimizerRequest,
    evidence_by_key: &BTreeMap<&VariantKey, &OptimizerAlleleEvidenceInput>,
) -> f64 {
    variants
        .iter()
        .map(|variant| {
            let copies = active_haplotypes(variant).len() as f64;
            let (_, components) = score_variant(
                &variant.key,
                source_keys.contains(&variant.key),
                request,
                evidence_by_key,
            );
            copies * components.objective_score
        })
        .sum()
}

fn score_variant(
    key: &VariantKey,
    exact_source_allele: bool,
    request: &OptimizerRequest,
    evidence_by_key: &BTreeMap<&VariantKey, &OptimizerAlleleEvidenceInput>,
) -> (OptimizerEvidence, OptimizerScoreComponents) {
    let input = evidence_by_key.get(key).copied();
    score_live_evidence(
        input.map(|value| &value.snpeff),
        input.map(|value| &value.clinvar),
        exact_source_allele,
        request,
    )
}

fn score_live_evidence(
    snpeff: Option<&EvidenceResult>,
    clinvar: Option<&EvidenceResult>,
    exact_source_allele: bool,
    request: &OptimizerRequest,
) -> (OptimizerEvidence, OptimizerScoreComponents) {
    let (impact_signal, impact_label) = snpeff
        .map(impact_signal_from_evidence)
        .unwrap_or((0.0, None));
    let clinvar_classification = clinvar.and_then(clinvar_classification);
    // ClinVar is deliberately not a numeric burden term. It is enforced as a
    // fixed candidate guard by the planners.
    let clinvar_signal = 0.0;
    let source_evidence_signal = f64::from(exact_source_allele);
    let evidence = OptimizerEvidence {
        impact_signal,
        impact_label,
        clinvar_signal,
        clinvar_classification,
        source_evidence_signal,
    };
    let (weighted_impact, weighted_clinvar, weighted_source_evidence, objective_score) =
        match request.objective {
            OptimizerObjective::AlternateAlleleBurden => (0.0, 0.0, 0.0, 1.0),
            OptimizerObjective::PredictedImpactBurden => {
                let impact = impact_signal * request.weights.impact;
                let clinvar = clinvar_signal * request.weights.clinvar;
                let source = source_evidence_signal * request.weights.source_evidence;
                (impact, clinvar, source, impact + clinvar + source)
            }
        };
    (
        evidence,
        OptimizerScoreComponents {
            alternate_allele: 1.0,
            weighted_impact,
            weighted_clinvar,
            weighted_source_evidence,
            objective_score,
        },
    )
}

fn impact_signal_from_evidence(evidence: &EvidenceResult) -> (f64, Option<String>) {
    evidence
        .records
        .iter()
        .filter_map(|record| {
            record
                .get("impact")
                .or_else(|| record.get("IMPACT"))
                .map(String::as_str)
        })
        .flat_map(split_labels)
        .filter_map(|label| impact_label_score(label).map(|score| (score, label)))
        .max_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(Ordering::Equal))
        .map(|(score, label)| (score, Some(label.trim().to_ascii_uppercase())))
        .unwrap_or((0.0, None))
}

fn impact_label_score(label: &str) -> Option<f64> {
    match label.trim().to_ascii_uppercase().as_str() {
        "HIGH" => Some(1.0),
        "MODERATE" => Some(0.67),
        "LOW" => Some(0.33),
        "MODIFIER" => Some(0.1),
        _ => None,
    }
}

fn clinvar_classification(evidence: &EvidenceResult) -> Option<String> {
    let values: Vec<String> = evidence
        .records
        .iter()
        .filter_map(|record| {
            record
                .iter()
                .find(|(key, _)| {
                    key.eq_ignore_ascii_case("CLNSIG") || key.eq_ignore_ascii_case("CLINVAR_CLNSIG")
                })
                .map(|(_, value)| value.clone())
        })
        .collect();
    (!values.is_empty()).then(|| values.join("|"))
}

fn clinvar_is_pathogenic_or_likely_pathogenic(evidence: &EvidenceResult) -> bool {
    clinvar_classification(evidence).is_some_and(|classification| {
        split_labels(&classification).any(|label| {
            matches!(
                label
                    .trim()
                    .replace([' ', '-'], "_")
                    .to_ascii_uppercase()
                    .as_str(),
                "PATHOGENIC" | "LIKELY_PATHOGENIC"
            )
        })
    })
}

fn split_labels(value: &str) -> impl Iterator<Item = &str> {
    value.split([',', '|', '/', '&'])
}

fn compare_candidates(left: &Candidate, right: &Candidate) -> Ordering {
    right
        .improvement
        .partial_cmp(&left.improvement)
        .unwrap_or(Ordering::Equal)
        .then_with(|| {
            left.proposal
                .source_variant
                .cmp(&right.proposal.source_variant)
        })
        .then_with(|| {
            haplotype_rank(left.proposal.haplotype).cmp(&haplotype_rank(right.proposal.haplotype))
        })
}

fn haplotype_rank(haplotype: Haplotype) -> u8 {
    match haplotype {
        Haplotype::One => 0,
        Haplotype::Two => 1,
        Haplotype::Unphased => 2,
    }
}

fn clean_zero(value: f64) -> f64 {
    if value.abs() < 1e-12 {
        0.0
    } else {
        value
    }
}

fn score_description(request: &OptimizerRequest) -> &'static str {
    if request.mode == OptimizerMode::Saturation {
        return "Comparable normalized SnpEff impact per allele copy across all non-reference SNV bases at the selected positions.";
    }
    match request.objective {
        OptimizerObjective::AlternateAlleleBurden => {
            "Number of alternate allele copies in the focused region; this measures distance from the reference, not biological burden."
        }
        OptimizerObjective::PredictedImpactBurden => {
            "Comparable normalized SnpEff molecular-impact proxy across live-evaluated non-reference alleles; ClinVar is a fixed exclusion guard, not a score weight."
        }
    }
}

fn no_op_reason(
    direction: OptimizerDirection,
    eligible_candidates: u32,
    considered_source_variants: u32,
    exclusions: &[OptimizerExclusion],
) -> String {
    if eligible_candidates > 0 {
        return "The edit limit prevented proposal selection.".into();
    }
    if exclusions
        .iter()
        .any(|exclusion| exclusion.reason.contains("zero score"))
    {
        return "Eligible source allele copies have zero score under the selected objective and weights."
            .into();
    }
    if considered_source_variants == 0 {
        return "The focused region contains no source alleles that the planner can change.".into();
    }
    match direction {
        OptimizerDirection::Minimize => {
            "No active source allele copies in the focused region are eligible for restoration."
                .into()
        }
        OptimizerDirection::Maximize if exclusions.is_empty() => {
            "Every source allele in the focused region is already present in the current track."
                .into()
        }
        OptimizerDirection::Maximize => {
            "No source allele can be reintroduced safely under the selected objective; review the reported exclusions."
                .into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::VariantOrigin;
    use pretty_assertions::assert_eq;

    fn key(position: u64, reference: &str, alternate: &str) -> VariantKey {
        VariantKey {
            assembly: "GRCh37".into(),
            contig: "1".into(),
            position,
            reference: reference.into(),
            alternate: alternate.into(),
        }
    }

    fn variant(
        key: VariantKey,
        haplotype1_alt: bool,
        haplotype2_alt: bool,
        unphased_alt: bool,
        info: &[(&str, &str)],
    ) -> EffectiveVariant {
        EffectiveVariant {
            key: key.clone(),
            haplotype1_alt,
            haplotype2_alt,
            unphased_alt,
            unphased_slot: unphased_alt.then_some(2),
            origin: VariantOrigin::Observed,
            edit_ids: Vec::new(),
            source_key: Some(key),
            source_info: info
                .iter()
                .map(|(name, value)| ((*name).into(), (*value).into()))
                .collect(),
        }
    }

    fn focus() -> FocusContext {
        FocusContext {
            contig: "1".into(),
            start: 1,
            end: 1_000,
        }
    }

    fn request(objective: OptimizerObjective, direction: OptimizerDirection) -> OptimizerRequest {
        OptimizerRequest {
            mode: OptimizerMode::Conservative,
            objective,
            direction,
            max_edits: 10,
            weights: OptimizerWeights::default(),
            selected_variants: Vec::new(),
            evidence_device_ids: Vec::new(),
        }
    }

    fn saturation_request(source: &VariantKey, direction: OptimizerDirection) -> OptimizerRequest {
        OptimizerRequest {
            mode: OptimizerMode::Saturation,
            objective: OptimizerObjective::PredictedImpactBurden,
            direction,
            max_edits: 10,
            weights: OptimizerWeights {
                impact: 1.0,
                clinvar: 0.0,
                source_evidence: 0.0,
            },
            selected_variants: vec![source.clone()],
            evidence_device_ids: vec![
                "org.dgw.builtin.snpeff".into(),
                "org.dgw.builtin.clinvar".into(),
            ],
        }
    }

    fn saturation_candidate(
        source: &VariantKey,
        alternate: &str,
        impact: Option<&str>,
    ) -> SaturationAlleleInput {
        let snpeff = EvidenceResult {
            source: "SnpEff".into(),
            status: if impact.is_some() {
                EvidenceStatus::Found
            } else {
                EvidenceStatus::NoExactMatch
            },
            records: impact
                .map(|impact| BTreeMap::from([("impact".into(), impact.into())]))
                .into_iter()
                .collect(),
            message: None,
        };
        SaturationAlleleInput {
            source_variant: source.clone(),
            candidate_variant: VariantKey {
                alternate: alternate.into(),
                ..source.clone()
            },
            snpeff,
            clinvar: EvidenceResult {
                source: "ClinVar".into(),
                status: EvidenceStatus::NoExactMatch,
                records: Vec::new(),
                message: None,
            },
            evidence_statuses: BTreeMap::from([(
                "org.dgw.builtin.snpeff".into(),
                if impact.is_some() {
                    "found"
                } else {
                    "noExactMatch"
                }
                .into(),
            )]),
            exact_evidence_sources: Vec::new(),
        }
    }

    fn live_evidence(
        variant: &VariantKey,
        impact: Option<&str>,
        clinvar: Option<&str>,
    ) -> OptimizerAlleleEvidenceInput {
        OptimizerAlleleEvidenceInput {
            variant: variant.clone(),
            snpeff: EvidenceResult {
                source: "SnpEff".into(),
                status: if impact.is_some() {
                    EvidenceStatus::Found
                } else {
                    EvidenceStatus::NotComputed
                },
                records: impact
                    .map(|impact| BTreeMap::from([("impact".into(), impact.into())]))
                    .into_iter()
                    .collect(),
                message: None,
            },
            clinvar: EvidenceResult {
                source: "ClinVar".into(),
                status: clinvar
                    .map(|_| EvidenceStatus::Found)
                    .unwrap_or(EvidenceStatus::NoExactMatch),
                records: clinvar
                    .map(|value| BTreeMap::from([("CLNSIG".into(), value.into())]))
                    .into_iter()
                    .collect(),
                message: None,
            },
        }
    }

    #[test]
    fn minimize_restores_only_active_source_copies() {
        let source = vec![variant(key(100, "A", "T"), false, true, false, &[])];
        let created = variant(key(200, "C", "G"), true, false, false, &[]);
        let current = vec![source[0].clone(), created];

        let plan = plan_optimizer(
            &current,
            &source,
            &focus(),
            &request(
                OptimizerObjective::AlternateAlleleBurden,
                OptimizerDirection::Minimize,
            ),
        )
        .unwrap();

        assert_eq!(plan.score_before, 2.0);
        assert_eq!(plan.score_after, 1.0);
        assert_eq!(plan.proposals.len(), 1);
        assert_eq!(plan.proposals[0].haplotype, Haplotype::Two);
        assert_eq!(
            plan.proposals[0].edit,
            EditKind::RestoreReference {
                source_key: key(100, "A", "T")
            }
        );
    }

    #[test]
    fn maximize_reintroduces_only_a_source_allele_and_preserves_unphased_state() {
        let source = vec![variant(key(101, "G", "A"), false, false, true, &[])];
        let evidence = [live_evidence(&source[0].key, None, None)];
        let plan = plan_optimizer_with_evidence(
            &[],
            &source,
            &focus(),
            &request(
                OptimizerObjective::AlternateAlleleBurden,
                OptimizerDirection::Maximize,
            ),
            &evidence,
        )
        .unwrap();

        assert_eq!(plan.score_before, 0.0);
        assert_eq!(plan.score_after, 1.0);
        assert_eq!(plan.proposals[0].haplotype, Haplotype::Unphased);
        assert_eq!(
            plan.proposals[0].edit,
            EditKind::SetAllele {
                key: key(101, "G", "A"),
                source_key: None
            }
        );
        assert!(plan
            .constraints
            .iter()
            .any(|value| value.contains("exact alleles")));
    }

    #[test]
    fn alt_copy_maximize_does_not_swap_one_alt_for_another() {
        let original_key = key(102, "C", "T");
        let replacement_key = key(102, "C", "G");
        let source = vec![variant(original_key.clone(), true, false, false, &[])];
        let mut replacement = variant(replacement_key.clone(), true, false, false, &[]);
        replacement.origin = VariantOrigin::Edited;
        replacement.source_key = Some(original_key.clone());

        let mut optimizer_request = request(
            OptimizerObjective::AlternateAlleleBurden,
            OptimizerDirection::Maximize,
        );
        optimizer_request.weights = OptimizerWeights::default();
        let evidence = [live_evidence(&original_key, None, None)];
        let plan = plan_optimizer_with_evidence(
            &[replacement],
            &source,
            &focus(),
            &optimizer_request,
            &evidence,
        )
        .unwrap();

        assert!(plan.proposals.is_empty());
        assert!(plan
            .exclusions
            .iter()
            .any(|exclusion| exclusion.reason.contains("would not increase")));
    }

    #[test]
    fn conservative_weighted_impact_does_not_assume_ref_is_benign() {
        let high = variant(
            key(110, "A", "G"),
            true,
            false,
            false,
            &[("ANN", "G|effect|HIGH"), ("CLNSIG", "Likely_pathogenic")],
        );
        let low = variant(
            key(120, "T", "C"),
            true,
            false,
            false,
            &[("ANN", "C|effect|LOW")],
        );
        let source = vec![low.clone(), high.clone()];
        let mut optimizer_request = request(
            OptimizerObjective::PredictedImpactBurden,
            OptimizerDirection::Minimize,
        );
        optimizer_request.max_edits = 1;
        optimizer_request.weights = OptimizerWeights {
            impact: 1.0,
            clinvar: 0.0,
            source_evidence: 0.0,
        };
        let evidence = [
            live_evidence(&high.key, Some("HIGH"), None),
            live_evidence(&low.key, Some("LOW"), None),
        ];
        let error =
            plan_optimizer_with_evidence(&source, &source, &focus(), &optimizer_request, &evidence)
                .unwrap_err();
        assert!(error
            .to_string()
            .contains("cannot treat REF as a zero-burden allele"));
    }

    #[test]
    fn maximize_reports_a_no_op_when_source_is_already_present() {
        let source = vec![variant(key(130, "A", "C"), true, false, false, &[])];
        let plan = plan_optimizer(
            &source,
            &source,
            &focus(),
            &request(
                OptimizerObjective::AlternateAlleleBurden,
                OptimizerDirection::Maximize,
            ),
        )
        .unwrap();

        assert!(plan.proposals.is_empty());
        assert_eq!(
            plan.no_op_reason.as_deref(),
            Some("Every source allele in the focused region is already present in the current track.")
        );
        assert!(plan.limitation.contains("independently scored"));
    }

    #[test]
    fn maximize_excludes_an_overlapping_active_allele() {
        let source = vec![variant(key(140, "AT", "A"), true, false, false, &[])];
        let mut overlap = variant(key(141, "T", "C"), true, false, false, &[]);
        overlap.origin = VariantOrigin::Created;
        overlap.source_key = None;

        let evidence = [live_evidence(&source[0].key, None, None)];
        let plan = plan_optimizer_with_evidence(
            &[overlap],
            &source,
            &focus(),
            &request(
                OptimizerObjective::AlternateAlleleBurden,
                OptimizerDirection::Maximize,
            ),
            &evidence,
        )
        .unwrap();

        assert!(plan.proposals.is_empty());
        assert_eq!(plan.exclusions.len(), 1);
        assert!(plan.exclusions[0].reason.contains("overlaps"));
    }

    #[test]
    fn validates_focus_limits_weights_and_duplicate_keys() {
        let source_variant = variant(key(150, "A", "G"), true, false, false, &[]);
        let mut invalid_request = request(
            OptimizerObjective::PredictedImpactBurden,
            OptimizerDirection::Minimize,
        );
        invalid_request.max_edits = MAX_OPTIMIZER_EDITS + 1;
        assert!(plan_optimizer(&[], &[], &focus(), &invalid_request).is_err());

        invalid_request.max_edits = 1;
        invalid_request.weights = OptimizerWeights {
            impact: 0.0,
            clinvar: 0.0,
            source_evidence: 0.0,
        };
        assert!(plan_optimizer(&[], &[], &focus(), &invalid_request).is_err());

        let duplicate = vec![source_variant.clone(), source_variant];
        assert!(plan_optimizer(
            &duplicate,
            &duplicate,
            &focus(),
            &request(
                OptimizerObjective::AlternateAlleleBurden,
                OptimizerDirection::Minimize,
            )
        )
        .is_err());
    }

    #[test]
    fn saturation_minimize_compares_all_non_reference_bases_and_preserves_placement() {
        let source_key = key(160, "A", "G");
        let current = variant(source_key.clone(), false, false, true, &[]);
        let candidates = vec![
            saturation_candidate(&source_key, "C", Some("HIGH")),
            saturation_candidate(&source_key, "G", Some("MODERATE")),
            saturation_candidate(&source_key, "T", Some("MODIFIER")),
        ];

        let plan = plan_saturation_optimizer(
            &[current],
            &focus(),
            &saturation_request(&source_key, OptimizerDirection::Minimize),
            &candidates,
        )
        .unwrap();

        assert_eq!(plan.candidate_comparisons.len(), 3);
        assert_eq!(plan.proposals.len(), 1);
        assert_eq!(plan.proposals[0].haplotype, Haplotype::Unphased);
        assert_eq!(
            plan.proposals[0].edit,
            EditKind::SetAllele {
                key: key(160, "A", "T"),
                source_key: Some(source_key)
            }
        );
        assert_eq!(
            plan.candidate_comparisons
                .iter()
                .find(|candidate| candidate.selected)
                .map(|candidate| candidate.candidate_variant.alternate.as_str()),
            Some("T")
        );
        assert!((plan.score_before - 0.67).abs() < 1e-12);
        assert!((plan.score_after - 0.1).abs() < 1e-12);
    }

    #[test]
    fn saturation_maximize_can_choose_a_new_high_impact_alt() {
        let source_key = key(170, "A", "G");
        let current = variant(source_key.clone(), true, false, false, &[]);
        let candidates = vec![
            saturation_candidate(&source_key, "C", Some("HIGH")),
            saturation_candidate(&source_key, "G", Some("LOW")),
            saturation_candidate(&source_key, "T", Some("MODIFIER")),
        ];

        let plan = plan_saturation_optimizer(
            &[current],
            &focus(),
            &saturation_request(&source_key, OptimizerDirection::Maximize),
            &candidates,
        )
        .unwrap();

        assert_eq!(plan.proposals.len(), 1);
        assert_eq!(
            plan.proposals[0].edit,
            EditKind::SetAllele {
                key: key(170, "A", "C"),
                source_key: Some(source_key)
            }
        );
        assert!((plan.score_after - 1.0).abs() < 1e-12);
    }

    #[test]
    fn saturation_never_selects_a_clinvar_pathogenic_candidate() {
        let source_key = key(175, "A", "G");
        let current = variant(source_key.clone(), true, false, false, &[]);
        let mut guarded = saturation_candidate(&source_key, "C", Some("MODIFIER"));
        guarded.clinvar = EvidenceResult {
            source: "ClinVar".into(),
            status: EvidenceStatus::Found,
            records: vec![BTreeMap::from([(
                "CLNSIG".into(),
                "Likely_pathogenic".into(),
            )])],
            message: None,
        };
        let candidates = vec![
            guarded,
            saturation_candidate(&source_key, "G", Some("HIGH")),
            saturation_candidate(&source_key, "T", Some("LOW")),
        ];

        let plan = plan_saturation_optimizer(
            &[current],
            &focus(),
            &saturation_request(&source_key, OptimizerDirection::Minimize),
            &candidates,
        )
        .unwrap();

        assert_eq!(plan.proposals.len(), 1);
        assert!(matches!(
            &plan.proposals[0].edit,
            EditKind::SetAllele { key, .. } if key.alternate == "T"
        ));
        assert!(plan.candidate_comparisons.iter().any(|candidate| {
            candidate.candidate_variant.alternate == "C"
                && !candidate.selected
                && candidate
                    .note
                    .as_deref()
                    .is_some_and(|note| note.contains("ClinVar"))
        }));
    }

    #[test]
    fn saturation_excludes_a_position_when_any_alt_is_not_comparable() {
        let source_key = key(180, "A", "G");
        let current = variant(source_key.clone(), true, false, false, &[]);
        let candidates = vec![
            saturation_candidate(&source_key, "C", Some("HIGH")),
            saturation_candidate(&source_key, "G", Some("LOW")),
            saturation_candidate(&source_key, "T", None),
        ];

        let plan = plan_saturation_optimizer(
            &[current],
            &focus(),
            &saturation_request(&source_key, OptimizerDirection::Minimize),
            &candidates,
        )
        .unwrap();

        assert!(plan.proposals.is_empty());
        assert_eq!(plan.exclusions.len(), 1);
        assert_eq!(plan.candidate_comparisons.len(), 3);
        assert!(plan
            .candidate_comparisons
            .iter()
            .any(|candidate| !candidate.comparable));
    }

    #[test]
    fn saturation_position_limit_keeps_a_two_copy_genotype_atomic() {
        let source_key = key(190, "A", "G");
        let current = variant(source_key.clone(), true, true, false, &[]);
        let candidates = vec![
            saturation_candidate(&source_key, "C", Some("HIGH")),
            saturation_candidate(&source_key, "G", Some("HIGH")),
            saturation_candidate(&source_key, "T", Some("LOW")),
        ];
        let mut optimizer_request = saturation_request(&source_key, OptimizerDirection::Minimize);
        optimizer_request.max_edits = 1;

        let plan = plan_saturation_optimizer(&[current], &focus(), &optimizer_request, &candidates)
            .unwrap();

        assert_eq!(plan.proposals.len(), 2);
        assert_eq!(plan.proposals[0].haplotype, Haplotype::One);
        assert_eq!(plan.proposals[1].haplotype, Haplotype::Two);
        assert!((plan.score_before - 2.0).abs() < 1e-12);
        assert!((plan.score_after - 0.66).abs() < 1e-12);
    }

    #[test]
    fn saturation_accepts_explicitly_selected_positions_outside_the_visible_contig() {
        let source_key = VariantKey {
            assembly: "GRCh37".into(),
            contig: "2".into(),
            position: 200,
            reference: "C".into(),
            alternate: "T".into(),
        };
        let current = variant(source_key.clone(), true, false, false, &[]);
        let candidates = vec![
            saturation_candidate(&source_key, "A", Some("MODIFIER")),
            saturation_candidate(&source_key, "G", Some("LOW")),
            saturation_candidate(&source_key, "T", Some("HIGH")),
        ];

        let plan = plan_saturation_optimizer(
            &[current],
            &focus(),
            &saturation_request(&source_key, OptimizerDirection::Minimize),
            &candidates,
        )
        .unwrap();

        assert_eq!(plan.proposals.len(), 1);
        assert_eq!(plan.proposals[0].source_variant.contig, "2");
        assert!(plan
            .constraints
            .iter()
            .any(|constraint| constraint.contains("any chromosome")));
    }
}
