use crate::error::{DgwError, Result};
use crate::model::{EditKind, EffectiveVariant, FocusContext, Haplotype, VariantKey};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

/// A run can propose only a small, reviewable set of edit operations.
pub const MAX_OPTIMIZER_EDITS: u32 = 100;

pub const ADDITIVE_SCORE_LIMITATION: &str = "Scores are additive sums of independently scored allele copies in the focused region. Interactions among nearby variants, phase-dependent combined consequences, penetrance, and whole-genome effects are not modeled.";

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
            clinvar: 1.0,
            source_evidence: 0.25,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerRequest {
    pub objective: OptimizerObjective,
    pub direction: OptimizerDirection,
    pub max_edits: u32,
    #[serde(default)]
    pub weights: OptimizerWeights,
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
    validate_request(focus, request)?;
    validate_unique_keys("current", current)?;
    validate_unique_keys("source", source)?;

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
        .filter(|variant| is_in_focus(&variant.key, focus))
        .collect();
    let considered_source_variants = source
        .iter()
        .filter(|variant| is_in_focus(&variant.key, focus))
        .count() as u32;
    let score_before = score_state(&focused_current, &source_keys, request);
    let mut candidates = Vec::new();
    let mut exclusions = Vec::new();

    match request.direction {
        OptimizerDirection::Minimize => {
            collect_minimize_candidates(
                &focused_current,
                &source_by_key,
                request,
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
        no_op_reason,
        score_description: score_description(request.objective).into(),
        limitation: ADDITIVE_SCORE_LIMITATION.into(),
        constraints: vec![
            "Candidates are restricted to exact alleles present in the original source input."
                .into(),
            format!(
                "One run emits at most {} reversible edit operations.",
                request.max_edits
            ),
            "Unphased source alleles remain unphased in proposed edits.".into(),
        ],
    })
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
    candidates: &mut Vec<Candidate>,
    exclusions: &mut Vec<OptimizerExclusion>,
) {
    for variant in current {
        if !source_by_key.contains_key(&variant.key) {
            continue;
        }
        let (evidence, components) = score_variant(variant, true, request);
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
    candidates: &mut Vec<Candidate>,
    exclusions: &mut Vec<OptimizerExclusion>,
) {
    let source_keys: BTreeSet<&VariantKey> = source.iter().map(|variant| &variant.key).collect();
    for source_variant in source
        .iter()
        .filter(|variant| is_in_focus(&variant.key, focus))
    {
        // Reintroduction is deliberately allele-level. A partially present
        // genotype is not rewritten because its copy/phase intent is ambiguous.
        if current_by_key
            .get(&source_variant.key)
            .is_some_and(|variant| !active_haplotypes(variant).is_empty())
        {
            continue;
        }

        let (evidence, components) = score_variant(source_variant, true, request);
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
                score_variant(variant, source_keys.contains(&variant.key), request).1
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
) -> f64 {
    variants
        .iter()
        .map(|variant| {
            let copies = active_haplotypes(variant).len() as f64;
            let (_, components) =
                score_variant(variant, source_keys.contains(&variant.key), request);
            copies * components.objective_score
        })
        .sum()
}

fn score_variant(
    variant: &EffectiveVariant,
    exact_source_allele: bool,
    request: &OptimizerRequest,
) -> (OptimizerEvidence, OptimizerScoreComponents) {
    let (impact_signal, impact_label) = impact_signal(&variant.source_info);
    let (clinvar_signal, clinvar_classification) = clinvar_signal(&variant.source_info);
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

fn impact_signal(info: &BTreeMap<String, String>) -> (f64, Option<String>) {
    let direct = info_value(info, &["IMPACT", "ANNOTATION_IMPACT"])
        .into_iter()
        .flat_map(split_labels);
    let ann = info_value(info, &["ANN"])
        .into_iter()
        .flat_map(|value| value.split(','))
        .filter_map(|annotation| annotation.split('|').nth(2));
    direct
        .chain(ann)
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

fn clinvar_signal(info: &BTreeMap<String, String>) -> (f64, Option<String>) {
    let Some(classification) = info_value(info, &["CLNSIG", "CLINVAR_CLNSIG"]) else {
        return (0.0, None);
    };
    let score = split_labels(classification)
        .filter_map(clinvar_label_score)
        .fold(0.0_f64, f64::max);
    (score, Some(classification.to_owned()))
}

fn clinvar_label_score(label: &str) -> Option<f64> {
    let normalized = label.trim().replace([' ', '-'], "_").to_ascii_uppercase();
    match normalized.as_str() {
        "PATHOGENIC" => Some(1.0),
        "LIKELY_PATHOGENIC" => Some(0.75),
        "UNCERTAIN_SIGNIFICANCE" | "CONFLICTING_CLASSIFICATIONS_OF_PATHOGENICITY" => Some(0.25),
        "BENIGN" | "LIKELY_BENIGN" | "BENIGN_LIKELY_BENIGN" => Some(0.0),
        _ => None,
    }
}

fn info_value<'a>(info: &'a BTreeMap<String, String>, names: &[&str]) -> Option<&'a str> {
    info.iter()
        .find(|(key, _)| names.iter().any(|name| key.eq_ignore_ascii_case(name)))
        .map(|(_, value)| value.as_str())
        .filter(|value| !value.is_empty() && *value != ".")
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

fn score_description(objective: OptimizerObjective) -> &'static str {
    match objective {
        OptimizerObjective::AlternateAlleleBurden => {
            "Number of alternate allele copies in the focused region."
        }
        OptimizerObjective::PredictedImpactBurden => {
            "Weighted sum of normalized SnpEff impact, recognized ClinVar classification, and exact source-membership signals per allele copy."
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
            objective,
            direction,
            max_edits: 10,
            weights: OptimizerWeights::default(),
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
        let plan = plan_optimizer(
            &[],
            &source,
            &focus(),
            &request(
                OptimizerObjective::AlternateAlleleBurden,
                OptimizerDirection::Maximize,
            ),
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
    fn maximize_can_reverse_a_replacement_without_inventing_an_allele() {
        let original_key = key(102, "C", "T");
        let replacement_key = key(102, "C", "G");
        let source = vec![variant(original_key.clone(), true, false, false, &[])];
        let mut replacement = variant(replacement_key.clone(), true, false, false, &[]);
        replacement.origin = VariantOrigin::Edited;
        replacement.source_key = Some(original_key.clone());

        let mut optimizer_request = request(
            OptimizerObjective::PredictedImpactBurden,
            OptimizerDirection::Maximize,
        );
        optimizer_request.weights = OptimizerWeights {
            impact: 0.0,
            clinvar: 0.0,
            source_evidence: 1.0,
        };
        let plan = plan_optimizer(&[replacement], &source, &focus(), &optimizer_request).unwrap();

        assert_eq!(plan.proposals.len(), 1);
        assert_eq!(
            plan.proposals[0].edit,
            EditKind::SetAllele {
                key: original_key,
                source_key: Some(replacement_key)
            }
        );
        assert_eq!(plan.proposals[0].score_delta, 1.0);
    }

    #[test]
    fn predicted_impact_ranks_candidates_and_obeys_the_edit_limit() {
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
            clinvar: 1.0,
            source_evidence: 0.0,
        };

        let plan = plan_optimizer(&source, &source, &focus(), &optimizer_request).unwrap();

        assert_eq!(plan.eligible_candidates, 2);
        assert_eq!(plan.proposals.len(), 1);
        assert_eq!(plan.proposals[0].source_variant, high.key);
        assert_eq!(
            plan.proposals[0].evidence.impact_label.as_deref(),
            Some("HIGH")
        );
        assert!((plan.proposals[0].score_delta + 1.75).abs() < 1e-12);
        assert!((plan.score_before - 2.08).abs() < 1e-12);
        assert!((plan.score_after - 0.33).abs() < 1e-12);
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

        let plan = plan_optimizer(
            &[overlap],
            &source,
            &focus(),
            &request(
                OptimizerObjective::AlternateAlleleBurden,
                OptimizerDirection::Maximize,
            ),
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
}
