import { describe, expect, it } from "vitest";
import { buildAlleleRoll } from "./alleleRoll";
import type { EffectiveVariant } from "./types";

function variant(position: number, alternate: string, placement: "one" | "two" | "unphased" = "two"): EffectiveVariant {
  return {
    key: { assembly: "GRCh37", contig: "7", position, reference: "A", alternate },
    haplotype1Alt: placement === "one",
    haplotype2Alt: placement === "two",
    unphasedAlt: placement === "unphased",
    origin: "observed",
    editIds: [],
    sourceInfo: {}
  };
}

describe("Allele Roll model", () => {
  it("keeps a bounded reference-coordinate window centered on the selection", () => {
    const selected = variant(110, "T");
    const columns = buildAlleleRoll(
      { contig: "7", start: 100, end: 120 },
      "AAAAAAAAAAAAAAAAAAAAA",
      [selected],
      selected,
      9
    );

    expect(columns).toHaveLength(9);
    expect(columns[0].position).toBe(106);
    expect(columns[4]).toMatchObject({ position: 110, selected: true, canonicalSnv: true });
  });

  it("represents phased copies without changing reference coordinates", () => {
    const selected = variant(103, "C", "one");
    const column = buildAlleleRoll({ contig: "7", start: 100, end: 105 }, "AAAAAA", [selected], selected)
      .find((item) => item.position === 103);

    expect(column).toMatchObject({ reference: "A", copyA: "C", copyB: "A", unphasedAlternate: undefined });
  });

  it("keeps an unphased ALT separate instead of inventing copy A or B", () => {
    const selected = variant(103, "G", "unphased");
    const column = buildAlleleRoll({ contig: "7", start: 100, end: 105 }, "AAAAAA", [selected], selected)
      .find((item) => item.position === 103);

    expect(column).toMatchObject({ copyA: "A", copyB: "A", unphasedAlternate: "G" });
  });

  it("shows indel loci but does not expose them as canonical roll SNVs", () => {
    const selected = { ...variant(103, "AT"), key: { ...variant(103, "AT").key, alternate: "AT" } };
    const column = buildAlleleRoll({ contig: "7", start: 100, end: 105 }, "AAAAAA", [selected], selected)
      .find((item) => item.position === 103);

    expect(column).toMatchObject({ selected: true, canonicalSnv: false });
  });

  it("keeps a restored VCF locus editable without showing its ALT as active", () => {
    const selected = variant(103, "T", "two");
    const column = buildAlleleRoll({ contig: "7", start: 100, end: 105 }, "AAAAAA", [], selected)
      .find((item) => item.position === 103);

    expect(column).toMatchObject({ selected: true, canonicalSnv: true, effective: false, copyA: "A", copyB: "A" });
  });
});
