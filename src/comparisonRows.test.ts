import { describe, it, expect } from "vitest";
import { comparisonRows, dnaChanged } from "./comparisonRows";
import { originalAllele } from "./alleleComparison";
import { predictionDifference } from "./ComparisonWorkspace";
import type { EffectiveVariant, GenomeTrackLane, EvidenceResult } from "./types";
const source: EffectiveVariant = { key: { assembly: "b37", contig: "7", position: 150, reference: "G", alternate: "A" }, haplotype1Alt: true, haplotype2Alt: false, unphasedAlt: false, origin: "observed", editIds: [], sourceInfo: {} };
const replacement = { ...source, sourceKey: source.key, key: { ...source.key, alternate: "C" } };
const lane = { track: { bypassedEditIds: [] }, variants: [replacement], edits: [] } as unknown as GenomeTrackLane;
describe("source comparison", () => {
  it("compares with the individual's ALT rather than reference", () => {
    const rows = comparisonRows([source], lane);
    expect(rows[0].source?.alternate).toBe("A");
    expect(rows[0].current?.key.alternate).toBe("C");
    expect(dnaChanged(rows[0])).toBe(true);
  });
  it("does not guess a source ALT from position alone", () => {
    expect(originalAllele({ ...replacement, sourceKey: undefined }, [source], [])).toBeUndefined();
  });
  it("follows chained replacements back to an imported allele", () => {
    const edits = [{ id: "first", parentStateId: "root", createdAt: "", haplotype: "one" as const, edit: { kind: "setAllele" as const, key: replacement.key, sourceKey: source.key } }];
    expect(originalAllele({ ...replacement, sourceKey: undefined }, [source], edits)).toEqual(source.key);
  });
  it("requires an explicit active edit to display a restored REF", () => {
    const restored = { ...lane, variants: [], edits: [{ id: "restore", parentStateId: "root", createdAt: "", haplotype: "one" as const, edit: { kind: "restoreReference" as const, sourceKey: source.key } }] };
    expect(comparisonRows([source], restored)[0].restored).toBe(true);
    expect(comparisonRows([source], { ...restored, track: { ...restored.track, bypassedEditIds: ["restore"] } })).toEqual([]);
    expect(comparisonRows([source], { ...lane, variants: [] })).toEqual([]);
  });
  it("separates missing, identical and different predictions", () => {
    const result: EvidenceResult = { source: "Variant Consequences", status: "found", records: [{ featureId: "t1", impact: "HIGH", effect: "stop_gained" }] };
    expect(predictionDifference(result, result)).toBe("same");
    expect(predictionDifference(result, undefined)).toBe("missing");
    expect(predictionDifference(result, { ...result, records: [] })).toBe("missing");
    expect(predictionDifference(result, { ...result, records: [{ featureId: "t1", impact: "LOW", effect: "synonymous" }] })).toBe("different");
  });
});
