import type { EffectiveVariant, FocusContext, VariantKey } from "./types";
import { selectionEvidenceKey } from "./selectedAlleleEvidence";

const sameKey = (a: VariantKey, b: VariantKey) => selectionEvidenceKey(a) === selectionEvidenceKey(b);

/** Resolve a refresh against the latest selection, not the request's old closure.
 * A restored/deleted ALT remains a locus anchor for inspecting its edit.
 * Never substitute an unrelated ALT at a multiallelic position.
 */
export function refreshedAlleleFocus(
  selected: EffectiveVariant | undefined,
  variants: EffectiveVariant[],
  context: FocusContext
): EffectiveVariant | undefined {
  if (!selected || selected.key.contig !== context.contig
    || selected.key.position < context.start || selected.key.position > context.end) return variants[0];
  const exact = variants.find(v => sameKey(v.key, selected.key));
  const lineage = variants.filter(v => sameKey(v.sourceKey ?? v.key, selected.sourceKey ?? selected.key)
    && v.haplotype1Alt === selected.haplotype1Alt
    && v.haplotype2Alt === selected.haplotype2Alt
    && v.unphasedAlt === selected.unphasedAlt
    && v.unphasedSlot === selected.unphasedSlot);
  const next = exact ?? (lineage.length === 1 ? lineage[0] : undefined);
  // Preserve object identity on an unchanged response: form effects must not
  // erase an unapplied proposal merely because the viewport refreshed.
  return !next || JSON.stringify(next) === JSON.stringify(selected) ? selected : next;
}
