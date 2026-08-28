import { describe, expect, it } from "vitest";
import type { EvidenceResult } from "./types";
import { snpeffImpactSignal } from "./trackMeter";

function evidence(status: EvidenceResult["status"], impacts: string[] = []): EvidenceResult {
  return {
    source: "SnpEff",
    status,
    records: impacts.map((impact) => ({ impact }))
  };
}

describe("track meter molecular-impact signal", () => {
  it("uses the strongest SnpEff impact on the exact allele", () => {
    expect(snpeffImpactSignal(evidence("found", ["LOW", "HIGH", "MODERATE"]))).toBe(1);
    expect(snpeffImpactSignal(evidence("found", ["MODIFIER", "MODERATE"]))).toBe(0.67);
  });

  it("keeps missing evaluation distinct from a found zero-impact result", () => {
    expect(snpeffImpactSignal(evidence("noExactMatch"))).toBeUndefined();
    expect(snpeffImpactSignal(evidence("found", ["UNKNOWN"]))).toBe(0);
  });
});
