import type { EditOperation, EffectiveVariant, VariantKey } from "./types";
import { selectionEvidenceKey } from "./selectedAlleleEvidence";

/** Resolve against actual imported alleles; never guess among ALTs at a locus. */
export function originalAllele(selected: EffectiveVariant | undefined, sources: EffectiveVariant[], edits: EditOperation[]): VariantKey | undefined {
  if (!selected) return undefined;
  let key = selected.sourceKey ?? selected.key;
  const seen = new Set<string>();
  while (!seen.has(selectionEvidenceKey(key))) {
    seen.add(selectionEvidenceKey(key));
    const source = sources.find(v => selectionEvidenceKey(v.key) === selectionEvidenceKey(key));
    if (source) return source.key;
    const prior = [...edits].reverse().find(e => e.edit.kind === "setAllele" && selectionEvidenceKey(e.edit.key) === selectionEvidenceKey(key));
    if (!prior || prior.edit.kind !== "setAllele" || !prior.edit.sourceKey) return undefined;
    key = prior.edit.sourceKey;
  }
  return undefined;
}

/** A missing ALT is not, by itself, proof of a reference call. */
export function savedAllele(
  selected: EffectiveVariant | undefined,
  variants: EffectiveVariant[],
  operation?: EditOperation
): { base?: string; restored: boolean } {
  if (!selected) return { restored: false };
  const key = selectionEvidenceKey(selected.key);
  if (variants.some(v => selectionEvidenceKey(v.key) === key
    && ((v.haplotype1Alt && selected.haplotype1Alt)
      || (v.haplotype2Alt && selected.haplotype2Alt)
      || (v.unphasedAlt && selected.unphasedAlt && v.unphasedSlot === selected.unphasedSlot)))) {
    return { base: selected.key.alternate, restored: false };
  }
  if (operation?.edit.kind === "restoreReference"
    && selectionEvidenceKey(operation.edit.sourceKey) === key) {
    return { base: selected.key.reference, restored: true };
  }
  return { restored: false };
}
