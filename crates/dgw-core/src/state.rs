use crate::error::{DgwError, Result};
use crate::model::{
    EditKind, EditOperation, EffectiveVariant, Haplotype, RootVariant, VariantKey, VariantOrigin,
};
use std::collections::{BTreeMap, BTreeSet};

pub fn validate_edit_shape(edit: &EditKind) -> Result<()> {
    match edit {
        EditKind::CompoundMutationLayer {
            layer_id,
            position_count,
            change_count,
        } => {
            if layer_id.trim().is_empty() || *position_count == 0 || *change_count == 0 {
                return Err(DgwError::InvalidEdit(
                    "compound mutation layer metadata is incomplete".into(),
                ));
            }
            Ok(())
        }
        EditKind::RestoreReference { source_key } => validate_key(source_key),
        EditKind::SetAllele {
            key, source_key, ..
        } => {
            validate_key(key)?;
            if let Some(source) = source_key {
                validate_key(source)?;
                if source.contig != key.contig {
                    return Err(DgwError::InvalidEdit(
                        "replacement must remain on the same contig".into(),
                    ));
                }
            }
            let reference_delta = key.reference.len().abs_diff(key.alternate.len());
            let is_snv = key.reference.len() == 1 && key.alternate.len() == 1;
            let is_short_indel =
                key.reference != key.alternate && reference_delta > 0 && reference_delta < 50;
            if !is_snv && !is_short_indel {
                return Err(DgwError::InvalidEdit(
                    "v1 edits must be SNVs or insertions/deletions of 1–49 bases".into(),
                ));
            }
            Ok(())
        }
    }
}

fn validate_key(key: &VariantKey) -> Result<()> {
    if key.position == 0 {
        return Err(DgwError::InvalidEdit("VCF positions are 1-based".into()));
    }
    if key.reference.is_empty() || key.alternate.is_empty() || key.reference == key.alternate {
        return Err(DgwError::InvalidEdit(
            "REF and ALT must be non-empty and different".into(),
        ));
    }
    if key.alternate.contains(',')
        || key.alternate.starts_with('<')
        || key.alternate.contains('[')
        || key.alternate.contains(']')
    {
        return Err(DgwError::InvalidEdit(
            "edits must contain one sequence-resolved ALT".into(),
        ));
    }
    let valid = |allele: &str| {
        allele
            .bytes()
            .all(|base| matches!(base.to_ascii_uppercase(), b'A' | b'C' | b'G' | b'T' | b'N'))
    };
    if !valid(&key.reference) || !valid(&key.alternate) {
        return Err(DgwError::InvalidEdit(
            "alleles may contain only A, C, G, T, or N".into(),
        ));
    }
    Ok(())
}

fn set_haplotype(variant: &mut EffectiveVariant, haplotype: Haplotype, value: bool) {
    match haplotype {
        Haplotype::One => variant.haplotype1_alt = value,
        Haplotype::Two => variant.haplotype2_alt = value,
        Haplotype::Unphased => variant.unphased_alt = value,
    }
}

fn haplotype_is_alt(variant: &EffectiveVariant, haplotype: Haplotype) -> bool {
    match haplotype {
        Haplotype::One => variant.haplotype1_alt,
        Haplotype::Two => variant.haplotype2_alt,
        // The unphased projection includes homozygous ALT records because they
        // are present regardless of phase.
        Haplotype::Unphased => {
            variant.unphased_alt || (variant.haplotype1_alt && variant.haplotype2_alt)
        }
    }
}

pub fn effective_variants(
    root: &[RootVariant],
    edits: &[EditOperation],
    bypassed_edit_ids: &[String],
) -> Result<Vec<EffectiveVariant>> {
    let mut variants: BTreeMap<VariantKey, EffectiveVariant> = root
        .iter()
        .map(|variant| {
            (
                variant.key.clone(),
                EffectiveVariant {
                    key: variant.key.clone(),
                    haplotype1_alt: variant.haplotype1_alt,
                    haplotype2_alt: variant.haplotype2_alt,
                    unphased_alt: variant.unphased_alt,
                    unphased_slot: variant.unphased_slot,
                    origin: VariantOrigin::Observed,
                    edit_ids: Vec::new(),
                    source_key: Some(variant.key.clone()),
                    // Imported INFO describes the frozen source record. Live
                    // device evidence is allele-specific and is evaluated
                    // independently, so source annotations are never part of
                    // the editable state projection.
                    source_info: BTreeMap::new(),
                },
            )
        })
        .collect();
    let bypassed: BTreeSet<&str> = bypassed_edit_ids.iter().map(String::as_str).collect();

    for operation in edits {
        if bypassed.contains(operation.id.as_str()) {
            continue;
        }
        validate_edit_shape(&operation.edit)?;
        match &operation.edit {
            EditKind::CompoundMutationLayer { .. } => {
                return Err(DgwError::InvalidEdit(
                    "compound mutation layer was not expanded before state projection".into(),
                ));
            }
            EditKind::RestoreReference { source_key } => {
                let source = variants.get_mut(source_key).ok_or_else(|| {
                    DgwError::InvalidEdit(format!(
                        "cannot restore absent allele {}",
                        source_key.display()
                    ))
                })?;
                set_haplotype(source, operation.haplotype, false);
                source.edit_ids.push(operation.id.clone());
                source.origin = VariantOrigin::Edited;
            }
            EditKind::SetAllele {
                key,
                source_key,
                unphased_slot,
            } => {
                let mut inherited_unphased_slot = None;
                if let Some(source_key) = source_key {
                    let source = variants.get_mut(source_key).ok_or_else(|| {
                        DgwError::InvalidEdit(format!(
                            "replacement source is absent: {}",
                            source_key.display()
                        ))
                    })?;
                    if !haplotype_is_alt(source, operation.haplotype) {
                        return Err(DgwError::InvalidEdit(format!(
                            "replacement source is not active on {:?}",
                            operation.haplotype
                        )));
                    }
                    if operation.haplotype == Haplotype::Unphased {
                        inherited_unphased_slot = source.unphased_slot;
                    }
                    set_haplotype(source, operation.haplotype, false);
                    source.edit_ids.push(operation.id.clone());
                    source.origin = VariantOrigin::Edited;
                }

                let variant = variants
                    .entry(key.clone())
                    .or_insert_with(|| EffectiveVariant {
                        key: key.clone(),
                        haplotype1_alt: false,
                        haplotype2_alt: false,
                        unphased_alt: false,
                        unphased_slot: inherited_unphased_slot.or(*unphased_slot),
                        origin: if source_key.is_some() {
                            VariantOrigin::Edited
                        } else {
                            VariantOrigin::Created
                        },
                        edit_ids: Vec::new(),
                        source_key: source_key.clone(),
                        source_info: BTreeMap::new(),
                    });
                let target_unphased_slot = inherited_unphased_slot
                    .or(*unphased_slot)
                    .or(variant.unphased_slot);
                // A replacement allele must never inherit annotations from
                // the source ALT, including when it resolves to an existing
                // state entry.
                variant.source_info.clear();
                if operation.haplotype == Haplotype::Unphased
                    && variant.unphased_alt
                    && variant.unphased_slot.is_some()
                    && target_unphased_slot.is_some()
                    && variant.unphased_slot != target_unphased_slot
                {
                    // Two different `/` slots now carry the same exact ALT,
                    // e.g. editing C/G to G/G. Phase is irrelevant for a
                    // homozygous genotype, so promote it to two explicit
                    // copies instead of collapsing both into one U flag.
                    variant.unphased_alt = false;
                    variant.unphased_slot = None;
                    variant.haplotype1_alt = true;
                    variant.haplotype2_alt = true;
                } else {
                    set_haplotype(variant, operation.haplotype, true);
                    if operation.haplotype == Haplotype::Unphased {
                        variant.unphased_slot = target_unphased_slot;
                    }
                }
                variant.edit_ids.push(operation.id.clone());
                if source_key.is_some() {
                    variant.origin = VariantOrigin::Edited;
                }
            }
        }
    }

    variants.retain(|_, variant| {
        variant.haplotype1_alt || variant.haplotype2_alt || variant.unphased_alt
    });
    Ok(variants.into_values().collect())
}

fn overlaps(left: &VariantKey, right: &VariantKey) -> bool {
    left.contig == right.contig && left.position <= right.end() && right.position <= left.end()
}

pub fn validate_no_overlap(
    effective: &[EffectiveVariant],
    haplotype: Haplotype,
    edit: &EditKind,
) -> Result<()> {
    // Overlapping unphased records may be on different chromosomes. Validate
    // them independently instead of inventing a shared haplotype.
    if haplotype == Haplotype::Unphased {
        return Ok(());
    }
    let (candidate, source_key) = match edit {
        EditKind::CompoundMutationLayer { .. } => {
            return Err(DgwError::InvalidEdit(
                "compound mutation layers must be validated through their allele changes".into(),
            ));
        }
        EditKind::RestoreReference { .. } => return Ok(()),
        EditKind::SetAllele {
            key, source_key, ..
        } => (key, source_key.as_ref()),
    };
    for variant in effective {
        if !haplotype_is_alt(variant, haplotype) {
            continue;
        }
        if source_key.is_some_and(|source| source == &variant.key) {
            continue;
        }
        if overlaps(candidate, &variant.key) {
            return Err(DgwError::InvalidEdit(format!(
                "{} overlaps active allele {} on the same haplotype",
                candidate.display(),
                variant.key.display()
            )));
        }
    }
    Ok(())
}

pub fn materialize_haplotype(
    reference: &str,
    region_start: u64,
    variants: &[EffectiveVariant],
    haplotype: Haplotype,
) -> Result<String> {
    let mut sequence = reference.to_ascii_uppercase();
    let region_end = region_start + reference.len() as u64 - 1;
    let mut applicable: Vec<&EffectiveVariant> = variants
        .iter()
        .filter(|variant| {
            haplotype_is_alt(variant, haplotype)
                && variant.key.position >= region_start
                && variant.key.end() <= region_end
        })
        .collect();
    applicable.sort_by(|left, right| right.key.position.cmp(&left.key.position));

    for variant in applicable {
        let start = (variant.key.position - region_start) as usize;
        let end = start + variant.key.reference.len();
        let observed = sequence.get(start..end).ok_or_else(|| {
            DgwError::InvalidEdit(format!("{} falls outside focus", variant.key.display()))
        })?;
        if !observed.eq_ignore_ascii_case(&variant.key.reference) {
            return Err(DgwError::InvalidEdit(format!(
                "REF mismatch while materializing {}: expected {}, observed {}",
                variant.key.display(),
                variant.key.reference,
                observed
            )));
        }
        sequence.replace_range(start..end, &variant.key.alternate);
    }
    Ok(sequence)
}

/// Reconstructs one copy while refusing to invent phase for heterozygous
/// unphased calls. Each phase-unknown REF span is represented by `N` bases on
/// both exported copies; callers can preserve the exact REF/ALT in a sidecar.
pub fn materialize_haplotype_masking_unphased(
    reference: &str,
    region_start: u64,
    variants: &[EffectiveVariant],
    haplotype: Haplotype,
) -> Result<String> {
    if haplotype == Haplotype::Unphased {
        return Err(DgwError::InvalidEdit(
            "a phase-unknown projection is not a genome copy".into(),
        ));
    }
    let region_end = region_start + reference.len() as u64 - 1;
    let mut applicable: Vec<(&EffectiveVariant, String)> = variants
        .iter()
        .filter(|variant| {
            (variant.unphased_alt || haplotype_is_alt(variant, haplotype))
                && variant.key.position >= region_start
                && variant.key.end() <= region_end
        })
        .map(|variant| {
            let replacement = if variant.unphased_alt {
                "N".repeat(variant.key.reference.len())
            } else {
                variant.key.alternate.clone()
            };
            (variant, replacement)
        })
        .collect();

    applicable.sort_by(|(left, _), (right, _)| left.key.position.cmp(&right.key.position));
    // A decomposed unphased 1/2 genotype has two exact ALT objects at the
    // same REF span. Both copies are already masked at that span, so apply one
    // mask while retaining both alleles for evidence and the uncertainty
    // sidecar.
    applicable.dedup_by(|(left, _), (right, _)| {
        left.unphased_alt
            && right.unphased_alt
            && left.key.contig == right.key.contig
            && left.key.position == right.key.position
            && left.key.reference == right.key.reference
    });
    for pair in applicable.windows(2) {
        if overlaps(&pair[0].0.key, &pair[1].0.key) {
            return Err(DgwError::InvalidEdit(format!(
                "cannot export overlapping alleles {} and {} on the same copy",
                pair[0].0.key.display(),
                pair[1].0.key.display()
            )));
        }
    }
    applicable.reverse();

    let mut sequence = reference.to_ascii_uppercase();
    for (variant, replacement) in applicable {
        let start = (variant.key.position - region_start) as usize;
        let end = start + variant.key.reference.len();
        let observed = sequence.get(start..end).ok_or_else(|| {
            DgwError::InvalidEdit(format!("{} falls outside focus", variant.key.display()))
        })?;
        if !observed.eq_ignore_ascii_case(&variant.key.reference) {
            return Err(DgwError::InvalidEdit(format!(
                "REF mismatch while exporting {}: expected {}, observed {}",
                variant.key.display(),
                variant.key.reference,
                observed
            )));
        }
        sequence.replace_range(start..end, &replacement);
    }
    Ok(sequence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::collections::BTreeMap;

    fn key(pos: u64, reference: &str, alternate: &str) -> VariantKey {
        VariantKey {
            assembly: "b37".into(),
            contig: "1".into(),
            position: pos,
            reference: reference.into(),
            alternate: alternate.into(),
        }
    }

    fn root_variant() -> RootVariant {
        RootVariant {
            key: key(3, "G", "T"),
            id: None,
            quality: None,
            filter: "PASS".into(),
            info: BTreeMap::new(),
            format_keys: vec!["GT".into()],
            sample_values: vec!["0|1".into()],
            haplotype1_alt: false,
            haplotype2_alt: true,
            unphased_alt: false,
            unphased_slot: None,
            source_line: String::new(),
        }
    }

    #[test]
    fn restores_and_bypasses_without_destroying_history() {
        let root = root_variant();
        let operation = EditOperation {
            id: "restore".into(),
            parent_state_id: "root".into(),
            haplotype: Haplotype::Two,
            edit: EditKind::RestoreReference {
                source_key: root.key.clone(),
            },
            note: None,
            created_at: Utc::now(),
        };
        assert!(
            effective_variants(&[root.clone()], &[operation.clone()], &[])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            effective_variants(&[root], &[operation], &["restore".into()])
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn materializes_sequence_in_reverse_coordinate_order() {
        let variants = vec![EffectiveVariant {
            key: key(3, "G", "GAA"),
            haplotype1_alt: true,
            haplotype2_alt: false,
            unphased_alt: false,
            unphased_slot: None,
            origin: VariantOrigin::Created,
            edit_ids: vec![],
            source_key: None,
            source_info: BTreeMap::new(),
        }];
        assert_eq!(
            materialize_haplotype("ACGT", 1, &variants, Haplotype::One).unwrap(),
            "ACGAAT"
        );
    }

    #[test]
    fn masks_unphased_alleles_on_both_exported_copies() {
        let variants = vec![EffectiveVariant {
            key: key(3, "G", "T"),
            haplotype1_alt: false,
            haplotype2_alt: false,
            unphased_alt: true,
            unphased_slot: Some(2),
            origin: VariantOrigin::Observed,
            edit_ids: vec![],
            source_key: None,
            source_info: BTreeMap::new(),
        }];
        assert_eq!(
            materialize_haplotype_masking_unphased("ACGT", 1, &variants, Haplotype::One).unwrap(),
            "ACNT"
        );
        assert_eq!(
            materialize_haplotype_masking_unphased("ACGT", 1, &variants, Haplotype::Two).unwrap(),
            "ACNT"
        );
    }

    #[test]
    fn masks_decomposed_unphased_one_two_alleles_once_at_the_shared_ref_span() {
        let variants = ["C", "T"].map(|alternate| EffectiveVariant {
            key: key(3, "G", alternate),
            haplotype1_alt: false,
            haplotype2_alt: false,
            unphased_alt: true,
            unphased_slot: Some(if alternate == "C" { 1 } else { 2 }),
            origin: VariantOrigin::Observed,
            edit_ids: vec![],
            source_key: None,
            source_info: BTreeMap::new(),
        });

        assert_eq!(
            materialize_haplotype_masking_unphased("ACGT", 1, &variants, Haplotype::One).unwrap(),
            "ACNT"
        );
        assert_eq!(
            materialize_haplotype_masking_unphased("ACGT", 1, &variants, Haplotype::Two).unwrap(),
            "ACNT"
        );
    }

    #[test]
    fn merging_unphased_one_two_alts_into_one_alt_produces_two_copies() {
        let root = [
            RootVariant {
                key: key(3, "G", "C"),
                id: None,
                quality: None,
                filter: "PASS".into(),
                info: BTreeMap::new(),
                format_keys: vec!["GT".into()],
                sample_values: vec!["1/0".into()],
                haplotype1_alt: false,
                haplotype2_alt: false,
                unphased_alt: true,
                unphased_slot: Some(1),
                source_line: String::new(),
            },
            RootVariant {
                key: key(3, "G", "T"),
                id: None,
                quality: None,
                filter: "PASS".into(),
                info: BTreeMap::new(),
                format_keys: vec!["GT".into()],
                sample_values: vec!["0/1".into()],
                haplotype1_alt: false,
                haplotype2_alt: false,
                unphased_alt: true,
                unphased_slot: Some(2),
                source_line: String::new(),
            },
        ];
        let edit = EditOperation {
            id: "merge".into(),
            parent_state_id: "root".into(),
            haplotype: Haplotype::Unphased,
            edit: EditKind::SetAllele {
                key: key(3, "G", "T"),
                source_key: Some(key(3, "G", "C")),
                unphased_slot: None,
            },
            note: None,
            created_at: Utc::now(),
        };

        let variants = effective_variants(&root, &[edit], &[]).unwrap();
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0].key.alternate, "T");
        assert!(variants[0].haplotype1_alt && variants[0].haplotype2_alt);
        assert!(!variants[0].unphased_alt);
        assert_eq!(variants[0].unphased_slot, None);
    }

    #[test]
    fn edit_json_uses_camel_case_and_accepts_legacy_source_key() {
        let source = key(3, "G", "T");
        let current: EditKind = serde_json::from_value(serde_json::json!({
            "kind": "restoreReference",
            "sourceKey": source
        }))
        .unwrap();
        assert!(matches!(current, EditKind::RestoreReference { .. }));

        let legacy: EditKind = serde_json::from_value(serde_json::json!({
            "kind": "restoreReference",
            "source_key": key(3, "G", "T")
        }))
        .unwrap();
        let encoded = serde_json::to_value(legacy).unwrap();
        assert!(encoded.get("sourceKey").is_some());
        assert!(encoded.get("source_key").is_none());
    }

    #[test]
    fn enforces_short_edit_scope() {
        let long = EditKind::SetAllele {
            key: key(1, "A", &format!("A{}", "T".repeat(50))),
            source_key: None,
            unphased_slot: None,
        };
        assert!(validate_edit_shape(&long).is_err());
    }

    #[test]
    fn imported_annotations_do_not_enter_state_or_follow_replacement_alleles() {
        let mut root = root_variant();
        root.info
            .insert("ANN".into(), "T|missense_variant|HIGH|SOURCE_ONLY".into());
        root.info.insert("CLNSIG".into(), "Pathogenic".into());

        let observed = effective_variants(&[root.clone()], &[], &[]).unwrap();
        assert_eq!(observed.len(), 1);
        assert!(observed[0].source_info.is_empty());

        let replacement = EditOperation {
            id: "replace-alt".into(),
            parent_state_id: "root".into(),
            haplotype: Haplotype::Two,
            edit: EditKind::SetAllele {
                key: key(3, "G", "C"),
                source_key: Some(root.key.clone()),
                unphased_slot: None,
            },
            note: None,
            created_at: Utc::now(),
        };
        let edited = effective_variants(&[root], &[replacement], &[]).unwrap();
        assert_eq!(edited.len(), 1);
        assert_eq!(edited[0].key.alternate, "C");
        assert!(edited[0].source_info.is_empty());
    }
}
