use crate::error::{DgwError, Result};
use crate::model::{CompoundMutationChange, EditKind, EffectiveVariant, Haplotype, VariantKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_MORPH_POSITIONS: usize = 100_000;
pub const MORPH_LIMITATION: &str = "Genome Morph creates a designed sequence of discrete genotype substitutions between compatible tracks. Intermediate states are synthetic editing scenarios, not ancestors, descendants, offspring, evolutionary time points, or evidence of biological viability.";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MorphOrdering {
    #[default]
    Genomic,
    SeededRandom,
}

impl MorphOrdering {
    pub fn label(self) -> &'static str {
        match self {
            Self::Genomic => "genomic order",
            Self::SeededRandom => "seeded random order",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMorphRequest {
    pub amount: u8,
    #[serde(default)]
    pub ordering: MorphOrdering,
    #[serde(default)]
    pub seed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackMorphPlan {
    pub request: TrackMorphRequest,
    pub differing_positions: u32,
    pub differing_alleles: u32,
    pub selected_positions: u32,
    pub generated_edits: u32,
    pub changes: Vec<CompoundMutationChange>,
    pub no_op_reason: Option<String>,
    pub limitation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMorphPreviewResult {
    pub source_track_id: String,
    pub source_state_id: String,
    pub target_track_id: String,
    pub target_state_id: String,
    pub amount: u8,
    pub differing_positions: u32,
    pub differing_alleles: u32,
    pub selected_positions: u32,
    pub generated_edits: u32,
    pub no_op_reason: Option<String>,
    pub limitation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound_layer_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Position {
    assembly: String,
    contig: String,
    position: u64,
}

impl Position {
    fn from_key(key: &VariantKey) -> Self {
        Self {
            assembly: key.assembly.clone(),
            contig: key.contig.clone(),
            position: key.position,
        }
    }

    fn stable_key(&self) -> String {
        format!("{}|{}|{}", self.assembly, self.contig, self.position)
    }
}

#[derive(Debug, Clone)]
struct UnphasedAllele {
    key: VariantKey,
    slot: Option<u8>,
}

type PhasedStates = BTreeMap<(Position, u8), VariantKey>;
type UnphasedStates = BTreeMap<Position, Vec<UnphasedAllele>>;

fn track_states(variants: &[EffectiveVariant]) -> (PhasedStates, UnphasedStates) {
    let mut phased = BTreeMap::new();
    let mut unphased: UnphasedStates = BTreeMap::new();
    for variant in variants {
        let position = Position::from_key(&variant.key);
        if variant.haplotype1_alt {
            phased.insert((position.clone(), 1), variant.key.clone());
        }
        if variant.haplotype2_alt {
            phased.insert((position.clone(), 2), variant.key.clone());
        }
        if variant.unphased_alt {
            unphased.entry(position).or_default().push(UnphasedAllele {
                key: variant.key.clone(),
                slot: variant.unphased_slot,
            });
        }
    }
    for alleles in unphased.values_mut() {
        alleles.sort_by(|left, right| {
            left.slot
                .cmp(&right.slot)
                .then_with(|| left.key.cmp(&right.key))
        });
    }
    (phased, unphased)
}

fn replacement(
    haplotype: Haplotype,
    source: Option<VariantKey>,
    target: Option<UnphasedAllele>,
) -> Option<CompoundMutationChange> {
    match (source, target) {
        (Some(source_key), Some(target)) if source_key != target.key => {
            Some(CompoundMutationChange {
                haplotype,
                edit: EditKind::SetAllele {
                    key: target.key,
                    source_key: Some(source_key),
                    unphased_slot: target.slot,
                },
            })
        }
        (Some(source_key), None) => Some(CompoundMutationChange {
            haplotype,
            edit: EditKind::RestoreReference { source_key },
        }),
        (None, Some(target)) => Some(CompoundMutationChange {
            haplotype,
            edit: EditKind::SetAllele {
                key: target.key,
                source_key: None,
                unphased_slot: target.slot,
            },
        }),
        _ => None,
    }
}

fn seeded_position_key(seed: u64, position: &Position) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(seed.to_le_bytes());
    hasher.update(position.stable_key().as_bytes());
    hasher.finalize().into()
}

/// Compare two effective states from the same project and create a stable
/// prefix of whole-position changes. Unphased alleles are compared as sets;
/// their GT order is not treated as chromosome identity.
pub fn plan_track_morph(
    source: &[EffectiveVariant],
    target: &[EffectiveVariant],
    request: &TrackMorphRequest,
) -> Result<TrackMorphPlan> {
    if request.amount > 100 {
        return Err(DgwError::InvalidEdit(
            "morph amount must be between 0 and 100".into(),
        ));
    }

    let (source_phased, source_unphased) = track_states(source);
    let (target_phased, target_unphased) = track_states(target);
    let mut by_position: BTreeMap<Position, Vec<CompoundMutationChange>> = BTreeMap::new();

    let mut phased_slots: Vec<_> = source_phased
        .keys()
        .chain(target_phased.keys())
        .cloned()
        .collect();
    phased_slots.sort();
    phased_slots.dedup();
    for (position, copy) in phased_slots {
        let source_key = source_phased.get(&(position.clone(), copy)).cloned();
        let target_key = target_phased
            .get(&(position.clone(), copy))
            .cloned()
            .map(|key| UnphasedAllele { key, slot: None });
        if let Some(change) = replacement(
            if copy == 1 {
                Haplotype::One
            } else {
                Haplotype::Two
            },
            source_key,
            target_key,
        ) {
            by_position.entry(position).or_default().push(change);
        }
    }

    let mut unphased_positions: Vec<_> = source_unphased
        .keys()
        .chain(target_unphased.keys())
        .cloned()
        .collect();
    unphased_positions.sort();
    unphased_positions.dedup();
    for position in unphased_positions {
        let mut remaining_source = source_unphased.get(&position).cloned().unwrap_or_default();
        let mut remaining_target = target_unphased.get(&position).cloned().unwrap_or_default();

        // GT order is not phase. Remove exact shared alleles before pairing
        // the remaining multiset so 1/2 and 2/1 compare as the same genotype.
        remaining_source.retain(|source_allele| {
            if let Some(index) = remaining_target
                .iter()
                .position(|target_allele| target_allele.key == source_allele.key)
            {
                remaining_target.remove(index);
                false
            } else {
                true
            }
        });

        let paired = remaining_source.len().min(remaining_target.len());
        for index in 0..paired {
            if let Some(change) = replacement(
                Haplotype::Unphased,
                Some(remaining_source[index].key.clone()),
                Some(remaining_target[index].clone()),
            ) {
                by_position
                    .entry(position.clone())
                    .or_default()
                    .push(change);
            }
        }
        for source_allele in remaining_source.into_iter().skip(paired) {
            if let Some(change) = replacement(Haplotype::Unphased, Some(source_allele.key), None) {
                by_position
                    .entry(position.clone())
                    .or_default()
                    .push(change);
            }
        }
        for target_allele in remaining_target.into_iter().skip(paired) {
            if let Some(change) = replacement(Haplotype::Unphased, None, Some(target_allele)) {
                by_position
                    .entry(position.clone())
                    .or_default()
                    .push(change);
            }
        }
    }

    let mut groups: Vec<_> = by_position.into_iter().collect();
    let differing_positions = groups.len();
    if differing_positions > MAX_MORPH_POSITIONS {
        return Err(DgwError::InvalidEdit(format!(
            "tracks differ at {differing_positions} positions; Genome Morph currently accepts at most {MAX_MORPH_POSITIONS} positions per run"
        )));
    }
    let differing_alleles = groups
        .iter()
        .map(|(_, changes)| changes.len())
        .sum::<usize>();
    if request.ordering == MorphOrdering::SeededRandom {
        groups.sort_by(|(left, _), (right, _)| {
            seeded_position_key(request.seed, left)
                .cmp(&seeded_position_key(request.seed, right))
                .then_with(|| left.cmp(right))
        });
    }
    let selected_positions = if request.amount == 0 || differing_positions == 0 {
        0
    } else {
        (differing_positions * request.amount as usize).div_ceil(100)
    };
    let changes: Vec<_> = groups
        .into_iter()
        .take(selected_positions)
        .flat_map(|(_, changes)| changes)
        .collect();
    let no_op_reason = if differing_positions == 0 {
        Some(
            "The selected and target tracks already have the same effective genotype state.".into(),
        )
    } else if request.amount == 0 {
        Some("Morph is at 0%, so the selected track remains unchanged.".into())
    } else {
        None
    };

    Ok(TrackMorphPlan {
        request: request.clone(),
        differing_positions: differing_positions as u32,
        differing_alleles: differing_alleles as u32,
        selected_positions: selected_positions as u32,
        generated_edits: changes.len() as u32,
        changes,
        no_op_reason,
        limitation: MORPH_LIMITATION.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::VariantOrigin;
    use std::collections::BTreeMap;

    fn variant(position: u64, alternate: &str, copy: Haplotype) -> EffectiveVariant {
        EffectiveVariant {
            key: VariantKey {
                assembly: "b37".into(),
                contig: "1".into(),
                position,
                reference: "A".into(),
                alternate: alternate.into(),
            },
            haplotype1_alt: copy == Haplotype::One,
            haplotype2_alt: copy == Haplotype::Two,
            unphased_alt: copy == Haplotype::Unphased,
            unphased_slot: (copy == Haplotype::Unphased).then_some(1),
            origin: VariantOrigin::Edited,
            edit_ids: Vec::new(),
            source_key: None,
            source_info: BTreeMap::new(),
        }
    }

    fn request(amount: u8) -> TrackMorphRequest {
        TrackMorphRequest {
            amount,
            ordering: MorphOrdering::Genomic,
            seed: 42,
        }
    }

    #[test]
    fn morph_replaces_restores_and_introduces_target_states() {
        let source = vec![
            variant(10, "C", Haplotype::One),
            variant(20, "G", Haplotype::Two),
        ];
        let target = vec![
            variant(10, "T", Haplotype::One),
            variant(30, "C", Haplotype::Two),
        ];
        let plan = plan_track_morph(&source, &target, &request(100)).unwrap();
        assert_eq!(plan.differing_positions, 3);
        assert_eq!(plan.generated_edits, 3);
        assert!(matches!(
            &plan.changes[0].edit,
            EditKind::SetAllele { key, source_key: Some(source), .. }
                if key.alternate == "T" && source.alternate == "C"
        ));
        assert!(matches!(
            &plan.changes[1].edit,
            EditKind::RestoreReference { source_key } if source_key.position == 20
        ));
        assert!(matches!(
            &plan.changes[2].edit,
            EditKind::SetAllele { key, source_key: None, .. } if key.position == 30
        ));
    }

    #[test]
    fn morph_percentage_is_a_stable_whole_position_prefix() {
        let source: Vec<_> = (1..=10)
            .map(|position| variant(position, "C", Haplotype::One))
            .collect();
        let target: Vec<_> = (1..=10)
            .map(|position| variant(position, "G", Haplotype::One))
            .collect();
        let quarter = plan_track_morph(&source, &target, &request(25)).unwrap();
        let half = plan_track_morph(&source, &target, &request(50)).unwrap();
        assert_eq!(quarter.selected_positions, 3);
        assert_eq!(half.selected_positions, 5);
        assert_eq!(quarter.changes, half.changes[..3]);
    }

    #[test]
    fn unphased_genotype_order_is_not_treated_as_a_difference() {
        let mut source_c = variant(10, "C", Haplotype::Unphased);
        source_c.unphased_slot = Some(1);
        let mut source_g = variant(10, "G", Haplotype::Unphased);
        source_g.unphased_slot = Some(2);
        let mut target_g = source_g.clone();
        target_g.unphased_slot = Some(1);
        let mut target_c = source_c.clone();
        target_c.unphased_slot = Some(2);
        let plan =
            plan_track_morph(&[source_c, source_g], &[target_g, target_c], &request(100)).unwrap();
        assert_eq!(plan.differing_positions, 0);
        assert!(plan.changes.is_empty());
    }

    #[test]
    fn seeded_random_order_is_reproducible_and_prefix_stable() {
        let source: Vec<_> = (1..=20)
            .map(|position| variant(position, "C", Haplotype::One))
            .collect();
        let target: Vec<_> = (1..=20)
            .map(|position| variant(position, "T", Haplotype::One))
            .collect();
        let random_request = TrackMorphRequest {
            amount: 40,
            ordering: MorphOrdering::SeededRandom,
            seed: 7,
        };
        let first = plan_track_morph(&source, &target, &random_request).unwrap();
        let second = plan_track_morph(&source, &target, &random_request).unwrap();
        assert_eq!(first.changes, second.changes);
        assert_eq!(first.selected_positions, 8);
    }
}
