import { describe, expect, it } from "vitest";
import type { EvidenceResult } from "./types";
import { consequenceImpactSignal } from "./trackMeter";

function evidence(status: EvidenceResult["status"], impacts: string[] = []): EvidenceResult {
  return {
    source: "Variant Consequences",
    status,
    records: impacts.map((impact) => ({ impact }))
  };
}

describe("track meter molecular-impact signal", () => {
  it("uses the strongest consequence impact on the exact allele", () => {
    expect(consequenceImpactSignal(evidence("found", ["LOW", "HIGH", "MODERATE"]))).toBe(1);
    expect(consequenceImpactSignal(evidence("found", ["MODIFIER", "MODERATE"]))).toBe(0.67);
  });

  it("keeps missing evaluation distinct from a found zero-impact result", () => {
    expect(consequenceImpactSignal(evidence("noExactMatch"))).toBeUndefined();
    expect(consequenceImpactSignal(evidence("found", ["UNKNOWN"]))).toBe(0);
  });
});
