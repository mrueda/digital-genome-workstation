import { describe, expect, it } from "vitest";
import { savedAllele } from "./alleleComparison";
import type { EditOperation, EffectiveVariant } from "./types";

const variant: EffectiveVariant = {
  key: { assembly: "b37", contig: "7", position: 150, reference: "G", alternate: "C" },
  haplotype1Alt: true, haplotype2Alt: false, unphasedAlt: false,
  origin: "edited", editIds: [], sourceInfo: {}
};
const restore: EditOperation = {
  id: "restore", parentStateId: "parent", createdAt: "", haplotype: "one",
  edit: { kind: "restoreReference", sourceKey: variant.key }
};
describe("saved allele comparison", () => {
  it("reports an active ALT without confusing it with REF", () => {
    expect(savedAllele(variant, [variant])).toEqual({ base: "C", restored: false });
  });
  it("does not infer a reference call from a missing ALT", () => {
    expect(savedAllele(variant, [])).toEqual({ restored: false });
  });
  it("identifies an explicit restoration", () => {
    expect(savedAllele(variant, [], restore)).toEqual({ base: "G", restored: true });
  });
  it("does not confuse the remaining ALT on the other copy with the restored copy", () => {
    const other = { ...variant, haplotype1Alt: false, haplotype2Alt: true };
    expect(savedAllele(variant, [other], restore)).toEqual({ base: "G", restored: true });
  });
  it("ignores an unrelated restoration", () => {
    expect(savedAllele(variant, [], { ...restore, edit: { kind: "restoreReference", sourceKey: { ...variant.key, alternate: "T" } } })).toEqual({ restored: false });
  });
});
