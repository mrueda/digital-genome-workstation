import { describe, expect, it } from "vitest";
import { buildVariantNavigationEntries } from "./variantNavigation";
import type { EffectiveVariant } from "./types";

function variant(contig: string, position: number): EffectiveVariant {
  return {
    key: { assembly: "b37", contig, position, reference: "A", alternate: "T" },
    haplotype1Alt: true,
    haplotype2Alt: false,
    unphasedAlt: false,
    origin: "observed",
    editIds: [],
    sourceInfo: {}
  };
}

describe("variant navigation", () => {
  it("groups variants under canonical chromosome boundaries", () => {
    const entries = buildVariantNavigationEntries([
      variant("17", 20),
      variant("7", 30),
      variant("7", 10),
      variant("X", 5)
    ]);

    expect(entries.map((entry) => entry.kind === "contig"
      ? `chr${entry.contig}:${entry.variantCount}`
      : `${entry.variant.key.contig}:${entry.variant.key.position}`
    )).toEqual(["chr7:2", "7:10", "7:30", "chr17:1", "17:20", "chrX:1", "X:5"]);
  });
});
