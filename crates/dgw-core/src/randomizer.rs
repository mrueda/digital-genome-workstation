use crate::error::{DgwError, Result};
use crate::model::{EditKind, EffectiveVariant, Haplotype, VariantKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const RANDOMIZER_LIMITATION: &str = "Randomization changes selected SNV alleles without predicting whether the result is biologically plausible, viable, or beneficial. Each generated allele must be evaluated independently.";
pub const MAX_RANDOMIZER_POSITIONS: usize = 1_000;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubstitutionPattern {
    #[default]
    Uniform,
    TransitionOnly,
    TransversionOnly,
    TiTvMix,
}

impl SubstitutionPattern {
    pub fn label(self) -> &'static str {
        match self {
            Self::Uniform => "uniform",
            Self::TransitionOnly => "transition-only",
            Self::TransversionOnly => "transversion-only",
            Self::TiTvMix => "Ti/Tv mix",
        }
    }
}

fn default_transition_probability() -> u8 {
    67
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RandomizerRequest {
    pub selected_variants: Vec<VariantKey>,
    pub amount: u8,
    pub seed: u64,
    #[serde(default)]
    pub substitution_pattern: SubstitutionPattern,
    #[serde(default = "default_transition_probability")]
    pub transition_probability: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RandomizerProposal {
    pub source_variant: VariantKey,
    pub replacement_variant: VariantKey,
    pub haplotype: Haplotype,
    pub edit: EditKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RandomizerExclusion {
    pub source_variant: VariantKey,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RandomizerPlan {
    pub request: RandomizerRequest,
    pub proposals: Vec<RandomizerProposal>,
    pub exclusions: Vec<RandomizerExclusion>,
    pub selected_positions: u32,
    pub randomized_positions: u32,
    pub transition_positions: u32,
    pub transversion_positions: u32,
    pub generated_edits: u32,
    pub no_op_reason: Option<String>,
    pub limitation: String,
}

/// Build a deterministic, non-mutating plan for selected effective SNV alleles.
/// `amount` is applied per VCF position; chromosome-copy placements are kept.
pub fn plan_randomizer(
    current: &[EffectiveVariant],
    request: &RandomizerRequest,
) -> Result<RandomizerPlan> {
    if request.selected_variants.len() > MAX_RANDOMIZER_POSITIONS {
        return Err(DgwError::InvalidEdit(format!(
            "randomizer selection contains {} alleles; the per-run limit is {}",
            request.selected_variants.len(),
            MAX_RANDOMIZER_POSITIONS
        )));
    }
    if request.amount > 100 {
        return Err(DgwError::InvalidEdit(
            "randomizer amount must be between 0 and 100".into(),
        ));
    }
    if request.transition_probability > 100 {
        return Err(DgwError::InvalidEdit(
            "randomizer transition probability must be between 0 and 100".into(),
        ));
    }

    let current_by_key: BTreeMap<&VariantKey, &EffectiveVariant> = current
        .iter()
        .map(|variant| (&variant.key, variant))
        .collect();
    let mut selected = BTreeSet::new();
    let mut proposals = Vec::new();
    let mut exclusions = Vec::new();
    let mut randomized_positions = 0_u32;
    let mut transition_positions = 0_u32;
    let mut transversion_positions = 0_u32;

    for key in &request.selected_variants {
        if !selected.insert(key.clone()) {
            continue;
        }
        let Some(variant) = current_by_key.get(key) else {
            exclusions.push(RandomizerExclusion {
                source_variant: key.clone(),
                reason: "The selected allele is no longer active on this track.".into(),
            });
            continue;
        };
        if !is_canonical_snv(key) {
            exclusions.push(RandomizerExclusion {
                source_variant: key.clone(),
                reason: "Version 1 randomizes canonical A/C/G/T SNVs only; indels and ambiguous alleles are unchanged.".into(),
            });
            continue;
        }
        if !selected_by_amount(request.seed, key, request.amount) {
            continue;
        }

        let Some((replacement_alternate, transition)) = replacement_alt(request, key) else {
            exclusions.push(RandomizerExclusion {
                source_variant: key.clone(),
                reason: unavailable_pattern_reason(request, key),
            });
            continue;
        };
        let replacement_variant = VariantKey {
            assembly: key.assembly.clone(),
            contig: key.contig.clone(),
            position: key.position,
            reference: key.reference.to_ascii_uppercase(),
            alternate: replacement_alternate,
        };
        let haplotypes = active_haplotypes(variant);
        if haplotypes.is_empty() {
            exclusions.push(RandomizerExclusion {
                source_variant: key.clone(),
                reason: "The selected allele has no active chromosome-copy placement.".into(),
            });
            continue;
        }
        randomized_positions += 1;
        if transition {
            transition_positions += 1;
        } else {
            transversion_positions += 1;
        }
        for haplotype in haplotypes {
            proposals.push(RandomizerProposal {
                source_variant: key.clone(),
                replacement_variant: replacement_variant.clone(),
                haplotype,
                edit: EditKind::SetAllele {
                    key: replacement_variant.clone(),
                    source_key: Some(key.clone()),
                },
            });
        }
    }

    let no_op_reason = if proposals.is_empty() {
        Some(if request.selected_variants.is_empty() {
            "Select one or more visible VCF alleles before previewing the randomizer.".into()
        } else if request.amount == 0 {
            "Amount is 0%, so no selected positions were changed.".into()
        } else if !exclusions.is_empty() {
            format!(
                "No selected positions have a new eligible ALT for the {} pattern; see the exclusions.",
                request.substitution_pattern.label()
            )
        } else {
            "No eligible selected SNV positions were chosen for this seed and amount.".into()
        })
    } else {
        None
    };
    let generated_edits = proposals.len() as u32;

    Ok(RandomizerPlan {
        request: request.clone(),
        proposals,
        exclusions,
        selected_positions: selected.len() as u32,
        randomized_positions,
        transition_positions,
        transversion_positions,
        generated_edits,
        no_op_reason,
        limitation: RANDOMIZER_LIMITATION.into(),
    })
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

fn hash_u64(namespace: &str, seed: u64, key: &VariantKey) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(seed.to_le_bytes());
    hasher.update(key.stable_key().as_bytes());
    let digest = hasher.finalize();
    u64::from_le_bytes(
        digest[..8]
            .try_into()
            .expect("SHA-256 prefix has eight bytes"),
    )
}

fn selected_by_amount(seed: u64, key: &VariantKey, amount: u8) -> bool {
    amount == 100 || (amount > 0 && hash_u64("select", seed, key) % 100 < u64::from(amount))
}

fn replacement_alt(request: &RandomizerRequest, key: &VariantKey) -> Option<(String, bool)> {
    let reference = key.reference.as_bytes()[0].to_ascii_uppercase();
    let current = key.alternate.as_bytes()[0].to_ascii_uppercase();
    let candidates: Vec<(u8, bool)> = [b'A', b'C', b'G', b'T']
        .into_iter()
        .filter(|base| *base != reference && *base != current)
        .map(|base| (base, is_transition(reference, base)))
        .collect();
    let requested_transition = match request.substitution_pattern {
        SubstitutionPattern::Uniform => None,
        SubstitutionPattern::TransitionOnly => Some(true),
        SubstitutionPattern::TransversionOnly => Some(false),
        SubstitutionPattern::TiTvMix => Some(
            hash_u64("substitution-class", request.seed, key) % 100
                < u64::from(request.transition_probability),
        ),
    };
    let eligible: Vec<(u8, bool)> = candidates
        .into_iter()
        .filter(|(_, transition)| {
            requested_transition.is_none_or(|requested| *transition == requested)
        })
        .collect();
    if eligible.is_empty() {
        return None;
    }
    let index = (hash_u64("alternate", request.seed, key) % eligible.len() as u64) as usize;
    let (alternate, transition) = eligible[index];
    Some((char::from(alternate).to_string(), transition))
}

fn is_transition(reference: u8, alternate: u8) -> bool {
    matches!(
        (reference, alternate),
        (b'A', b'G') | (b'G', b'A') | (b'C', b'T') | (b'T', b'C')
    )
}

fn unavailable_pattern_reason(request: &RandomizerRequest, key: &VariantKey) -> String {
    let requested = match request.substitution_pattern {
        SubstitutionPattern::TransitionOnly => "transition",
        SubstitutionPattern::TransversionOnly => "transversion",
        SubstitutionPattern::TiTvMix => {
            let transition = hash_u64("substitution-class", request.seed, key) % 100
                < u64::from(request.transition_probability);
            if transition {
                "transition"
            } else {
                "transversion"
            }
        }
        SubstitutionPattern::Uniform => "substitution",
    };
    format!(
        "The {} pattern requested a {requested}, but no new non-REF ALT of that class is available at this position.",
        request.substitution_pattern.label()
    )
}

fn active_haplotypes(variant: &EffectiveVariant) -> Vec<Haplotype> {
    let mut result = Vec::with_capacity(3);
    if variant.haplotype1_alt {
        result.push(Haplotype::One);
    }
    if variant.haplotype2_alt {
        result.push(Haplotype::Two);
    }
    if variant.unphased_alt {
        result.push(Haplotype::Unphased);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::VariantOrigin;
    use std::collections::BTreeMap;

    fn variant(position: u64, reference: &str, alternate: &str) -> EffectiveVariant {
        EffectiveVariant {
            key: VariantKey {
                assembly: "b37".into(),
                contig: "1".into(),
                position,
                reference: reference.into(),
                alternate: alternate.into(),
            },
            haplotype1_alt: true,
            haplotype2_alt: false,
            unphased_alt: false,
            origin: VariantOrigin::Observed,
            edit_ids: Vec::new(),
            source_key: None,
            source_info: BTreeMap::new(),
        }
    }

    fn request(variants: &[EffectiveVariant], amount: u8, seed: u64) -> RandomizerRequest {
        RandomizerRequest {
            selected_variants: variants.iter().map(|variant| variant.key.clone()).collect(),
            amount,
            seed,
            substitution_pattern: SubstitutionPattern::Uniform,
            transition_probability: default_transition_probability(),
        }
    }

    #[test]
    fn same_seed_produces_same_plan() {
        let variants = vec![variant(100, "A", "C"), variant(110, "G", "T")];
        let request = request(&variants, 100, 42);
        assert_eq!(
            plan_randomizer(&variants, &request).unwrap(),
            plan_randomizer(&variants, &request).unwrap()
        );
    }

    #[test]
    fn full_amount_changes_every_selected_snv_without_using_ref_or_current_alt() {
        let variants = vec![variant(100, "A", "C"), variant(110, "G", "T")];
        let plan = plan_randomizer(&variants, &request(&variants, 100, 7)).unwrap();
        assert_eq!(plan.randomized_positions, 2);
        assert_eq!(plan.generated_edits, 2);
        for proposal in plan.proposals {
            assert_ne!(
                proposal.replacement_variant.alternate,
                proposal.source_variant.reference
            );
            assert_ne!(
                proposal.replacement_variant.alternate,
                proposal.source_variant.alternate
            );
        }
    }

    #[test]
    fn preserves_both_copy_and_unphased_placements() {
        let mut both = variant(100, "A", "G");
        both.haplotype2_alt = true;
        let mut unphased = variant(110, "C", "T");
        unphased.haplotype1_alt = false;
        unphased.unphased_alt = true;
        let variants = vec![both, unphased];
        let plan = plan_randomizer(&variants, &request(&variants, 100, 9)).unwrap();
        let placements: Vec<Haplotype> = plan.proposals.iter().map(|item| item.haplotype).collect();
        assert_eq!(
            placements,
            vec![Haplotype::One, Haplotype::Two, Haplotype::Unphased]
        );
    }

    #[test]
    fn excludes_indels_and_ambiguous_snvs() {
        let variants = vec![variant(100, "A", "AT"), variant(110, "N", "T")];
        let plan = plan_randomizer(&variants, &request(&variants, 100, 1)).unwrap();
        assert!(plan.proposals.is_empty());
        assert_eq!(plan.exclusions.len(), 2);
    }

    #[test]
    fn zero_amount_is_a_no_op() {
        let variants = vec![variant(100, "A", "C")];
        let plan = plan_randomizer(&variants, &request(&variants, 0, 1)).unwrap();
        assert!(plan.proposals.is_empty());
        assert!(plan.no_op_reason.unwrap().contains("0%"));
    }

    #[test]
    fn transition_only_generates_transitions_and_excludes_an_existing_transition() {
        let variants = vec![variant(100, "A", "C"), variant(110, "A", "G")];
        let mut request = request(&variants, 100, 1);
        request.substitution_pattern = SubstitutionPattern::TransitionOnly;
        let plan = plan_randomizer(&variants, &request).unwrap();
        assert_eq!(plan.transition_positions, 1);
        assert_eq!(plan.transversion_positions, 0);
        assert_eq!(plan.proposals[0].replacement_variant.alternate, "G");
        assert_eq!(plan.exclusions.len(), 1);
    }

    #[test]
    fn transversion_only_generates_no_transitions() {
        let variants = vec![variant(100, "A", "G"), variant(110, "C", "T")];
        let mut request = request(&variants, 100, 4);
        request.substitution_pattern = SubstitutionPattern::TransversionOnly;
        let plan = plan_randomizer(&variants, &request).unwrap();
        assert_eq!(plan.transition_positions, 0);
        assert_eq!(plan.transversion_positions, 2);
        assert!(plan.proposals.iter().all(|proposal| !is_transition(
            proposal.source_variant.reference.as_bytes()[0],
            proposal.replacement_variant.alternate.as_bytes()[0]
        )));
    }

    #[test]
    fn titv_extremes_match_strict_substitution_classes() {
        let variants = vec![variant(100, "A", "C")];
        let mut transition_request = request(&variants, 100, 12);
        transition_request.substitution_pattern = SubstitutionPattern::TiTvMix;
        transition_request.transition_probability = 100;
        let transition_plan = plan_randomizer(&variants, &transition_request).unwrap();
        assert_eq!(transition_plan.transition_positions, 1);

        let mut transversion_request = transition_request;
        transversion_request.transition_probability = 0;
        let transversion_plan = plan_randomizer(&variants, &transversion_request).unwrap();
        assert_eq!(transversion_plan.transversion_positions, 1);
    }

    #[test]
    fn titv_request_uses_the_frontend_protocol_names() {
        let variants = vec![variant(100, "A", "C")];
        let mut request = request(&variants, 100, 12);
        request.substitution_pattern = SubstitutionPattern::TiTvMix;
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["substitutionPattern"], "tiTvMix");
        assert_eq!(value["transitionProbability"], 67);
    }

    #[test]
    fn rejects_more_than_one_thousand_selected_positions() {
        let variants: Vec<EffectiveVariant> = (1..=MAX_RANDOMIZER_POSITIONS + 1)
            .map(|position| variant(position as u64, "A", "C"))
            .collect();
        let error = plan_randomizer(&variants, &request(&variants, 100, 42)).unwrap_err();
        assert!(error.to_string().contains("1001 alleles"));
        assert!(error.to_string().contains("limit is 1000"));
    }
}
