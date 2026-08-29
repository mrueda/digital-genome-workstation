import type { EffectiveVariant } from "./types";

export type VariantNavigationEntry =
  | { kind: "contig"; contig: string; variantCount: number }
  | { kind: "variant"; variant: EffectiveVariant };

function canonicalContigRank(contig: string) {
  const normalized = contig.replace(/^chr/i, "");
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 22) return numeric;
  if (normalized.toUpperCase() === "X") return 23;
  if (normalized.toUpperCase() === "Y") return 24;
  if (["M", "MT"].includes(normalized.toUpperCase())) return 25;
  return 1_000;
}

export function buildVariantNavigationEntries(variants: EffectiveVariant[]): VariantNavigationEntry[] {
  const sorted = [...variants].sort((left, right) => {
    const rankDelta = canonicalContigRank(left.key.contig) - canonicalContigRank(right.key.contig);
    if (rankDelta !== 0) return rankDelta;
    const contigDelta = left.key.contig.localeCompare(right.key.contig, undefined, { numeric: true });
    if (contigDelta !== 0) return contigDelta;
    return left.key.position - right.key.position
      || left.key.reference.localeCompare(right.key.reference)
      || left.key.alternate.localeCompare(right.key.alternate);
  });
  const counts = new Map<string, number>();
  for (const variant of sorted) counts.set(variant.key.contig, (counts.get(variant.key.contig) ?? 0) + 1);

  const entries: VariantNavigationEntry[] = [];
  let previousContig: string | undefined;
  for (const variant of sorted) {
    if (variant.key.contig !== previousContig) {
      entries.push({ kind: "contig", contig: variant.key.contig, variantCount: counts.get(variant.key.contig) ?? 0 });
      previousContig = variant.key.contig;
    }
    entries.push({ kind: "variant", variant });
  }
  return entries;
}
