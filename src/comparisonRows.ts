import type { EffectiveVariant, GenomeTrackLane, VariantKey } from "./types";
import { originalAllele } from "./alleleComparison";
import { selectionEvidenceKey as keyId } from "./selectedAlleleEvidence";

export interface ComparisonRow {
  id: string;
  source?: VariantKey;
  current?: EffectiveVariant;
  editId?: string;
  restored: boolean;
  copy: string;
}

export function comparisonRows(sources: EffectiveVariant[], lane?: GenomeTrackLane): ComparisonRow[] {
  if (!lane) return [];
  const rows: ComparisonRow[] = lane.variants.map(current => ({
    id: `${keyId(current.key)}:${current.unphasedSlot ?? ""}`,
    source: originalAllele(current, sources, lane.edits), current, restored: false,
    copy: current.unphasedAlt ? "Unphased" : [current.haplotype1Alt && "A", current.haplotype2Alt && "B"].filter(Boolean).join(" + ")
  }));
  for (const edit of lane.edits) {
    if (edit.edit.kind !== "restoreReference" || lane.track.bypassedEditIds.includes(edit.id)) continue;
    const anchor: EffectiveVariant = {
      key: edit.edit.sourceKey, haplotype1Alt: edit.haplotype === "one", haplotype2Alt: edit.haplotype === "two",
      unphasedAlt: edit.haplotype === "unphased", origin: "edited", editIds: [edit.id], sourceInfo: {}
    };
    const source = originalAllele(anchor, sources, lane.edits);
    if (!source) continue;
    // Do not label a superseded restoration as the current state.
    const stillActive = rows.some(row => row.source && keyId(row.source) === keyId(source) && row.current
      && ((anchor.haplotype1Alt && row.current.haplotype1Alt) || (anchor.haplotype2Alt && row.current.haplotype2Alt) || (anchor.unphasedAlt && row.current.unphasedAlt)));
    if (!stillActive && !rows.some(row => row.editId === edit.id)) rows.push({ id: edit.id, source, editId: edit.id, restored: true, copy: edit.haplotype === "unphased" ? "Unphased" : edit.haplotype === "one" ? "A" : "B" });
  }
  return rows.sort((a, b) => (a.source ?? a.current!.key).position - (b.source ?? b.current!.key).position);
}

export function dnaChanged(row: ComparisonRow) {
  return row.restored || !row.source || !row.current || keyId(row.source) !== keyId(row.current.key);
}
