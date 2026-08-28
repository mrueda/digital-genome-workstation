use crate::error::{DgwError, Result};
use crate::model::{EditKind, EffectiveVariant, Haplotype, VariantKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const RANDOMIZER_LIMITATION: &str = "Randomization changes selected SNV alleles without predicting whether the result is biologically plausible, viable, or beneficial. Each generated allele must be evaluated independently.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RandomizerRequest {
    pub selected_variants: Vec<VariantKey>,
    pub amount: u8,
    pub seed: u64,
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
    if request.amount > 100 {
        return Err(DgwError::InvalidEdit(
            "randomizer amount must be between 0 and 100".into(),
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

        let replacement_variant = VariantKey {
            assembly: key.assembly.clone(),
            contig: key.contig.clone(),
            position: key.position,
            reference: key.reference.to_ascii_uppercase(),
            alternate: replacement_alt(request.seed, key),
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

fn replacement_alt(seed: u64, key: &VariantKey) -> String {
    let reference = key.reference.as_bytes()[0].to_ascii_uppercase();
    let current = key.alternate.as_bytes()[0].to_ascii_uppercase();
    let candidates: Vec<u8> = [b'A', b'C', b'G', b'T']
        .into_iter()
        .filter(|base| *base != reference && *base != current)
        .collect();
    let index = (hash_u64("alternate", seed, key) % candidates.len() as u64) as usize;
    char::from(candidates[index]).to_string()
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
}
