import type { EvidenceResult } from "./types";

/**
 * Small, explicit molecular-impact signal used by the source-relative meter.
 * It is deliberately limited to transcript-consequence impact categories and is not a disease
 * or clinical-risk score.
 */
export function consequenceImpactSignal(evidence?: EvidenceResult) {
  if (!evidence || evidence.status !== "found") return undefined;
  const values = evidence.records.map((record) => {
    switch (record.impact?.toUpperCase()) {
      case "HIGH": return 1;
      case "MODERATE": return 0.67;
      case "LOW": return 0.33;
      case "MODIFIER": return 0.1;
      default: return 0;
    }
  });
  return values.length > 0 ? Math.max(...values) : 0;
}
