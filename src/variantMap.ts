export type VariantMapTone = "higher" | "lower" | "neutral" | "unknown";

export function variantMapTone(delta?: number): VariantMapTone {
  if (delta === undefined || !Number.isFinite(delta)) return "unknown";
  if (delta > 0.005) return "higher";
  if (delta < -0.005) return "lower";
  return "neutral";
}

export function variantMapY(
  delta: number | undefined,
  scale: number,
  top: number,
  baseline: number,
  bottom: number
) {
  if (delta === undefined || !Number.isFinite(delta)) return baseline;
  const normalized = Math.max(-1, Math.min(1, delta / Math.max(0.01, scale)));
  return normalized >= 0
    ? baseline - normalized * (baseline - top)
    : baseline + -normalized * (bottom - baseline);
}

/** Keep a bounded, positionally representative set of marks without hiding either endpoint. */
export function sampleVariantMapMarks<T>(values: readonly T[], limit: number): T[] {
  if (limit <= 0 || values.length === 0) return [];
  if (values.length <= limit) return [...values];
  if (limit === 1) return [values[0]];
  return Array.from({ length: limit }, (_, index) => (
    values[Math.round(index * (values.length - 1) / (limit - 1))]
  ));
}
