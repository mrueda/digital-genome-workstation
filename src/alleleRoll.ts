import type { EffectiveVariant, FocusContext } from "./types";

export const ALLELE_ROLL_BASES = ["A", "C", "G", "T"] as const;

export interface AlleleRollColumn {
  position: number;
  reference: string;
  variant?: EffectiveVariant;
  effective: boolean;
  selected: boolean;
  canonicalSnv: boolean;
  copyA: string;
  copyB: string;
  unphasedAlternate?: string;
}

function canonicalBase(value: string): boolean {
  return /^[ACGT]$/.test(value.toUpperCase());
}

function sameAllele(left: EffectiveVariant, right?: EffectiveVariant): boolean {
  return Boolean(right)
    && left.key.assembly === right?.key.assembly
    && left.key.contig === right.key.contig
    && left.key.position === right.key.position
    && left.key.reference === right.key.reference
    && left.key.alternate === right.key.alternate;
}

/**
 * Builds a reference-coordinate view. Haplotype strings are deliberately not
 * indexed here: indels change their length, while this roll must stay aligned
 * to immutable VCF/FASTA coordinates.
 */
export function buildAlleleRoll(
  context: FocusContext,
  referenceSequence: string | undefined,
  variants: EffectiveVariant[],
  selected?: EffectiveVariant,
  maximumColumns = 41
): AlleleRollColumn[] {
  if (!referenceSequence || context.end < context.start || maximumColumns < 1) return [];

  const availableLength = Math.min(referenceSequence.length, context.end - context.start + 1);
  const columnCount = Math.min(maximumColumns, availableLength);
  const requestedCenter = selected?.key.contig === context.contig
    ? selected.key.position
    : context.start + Math.floor((availableLength - 1) / 2);
  const minimumStart = context.start;
  const maximumStart = context.start + availableLength - columnCount;
  const windowStart = Math.max(minimumStart, Math.min(maximumStart, requestedCenter - Math.floor(columnCount / 2)));
  const variantsByPosition = new Map<number, { variant: EffectiveVariant; effective: boolean }>();

  for (const variant of variants) {
    if (variant.key.contig !== context.contig) continue;
    const previous = variantsByPosition.get(variant.key.position);
    if (!previous || sameAllele(variant, selected)) variantsByPosition.set(variant.key.position, { variant, effective: true });
  }
  if (selected?.key.contig === context.contig && !variantsByPosition.has(selected.key.position)) {
    // A restored allele is absent from the effective variant list, but its
    // imported VCF locus remains a valid editing anchor.
    variantsByPosition.set(selected.key.position, { variant: selected, effective: false });
  }

  return Array.from({ length: columnCount }, (_, index) => {
    const position = windowStart + index;
    const reference = referenceSequence[position - context.start]?.toUpperCase() ?? "N";
    const locus = variantsByPosition.get(position);
    const variant = locus?.variant;
    const effective = locus?.effective ?? false;
    const alternate = variant?.key.alternate.toUpperCase();
    const canonicalSnv = Boolean(
      variant
      && canonicalBase(variant.key.reference)
      && canonicalBase(variant.key.alternate)
      && variant.key.reference.length === 1
      && variant.key.alternate.length === 1
    );

    return {
      position,
      reference,
      variant,
      effective,
      selected: Boolean(selected && position === selected.key.position && variant?.key.reference === selected.key.reference),
      canonicalSnv,
      copyA: effective && canonicalSnv && variant?.haplotype1Alt ? alternate! : reference,
      copyB: effective && canonicalSnv && variant?.haplotype2Alt ? alternate! : reference,
      unphasedAlternate: effective && canonicalSnv && variant?.unphasedAlt ? alternate : undefined
    };
  });
}
