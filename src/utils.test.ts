import { describe, expect, it } from "vitest";
import { chromosomeLabel, filterSamples, projectSlug, sequenceChunks, sequenceDisplayParts, variantLabel } from "./utils";

describe("workspace helpers", () => {
  it("formats stable genomic labels", () => {
    expect(
      variantLabel({ assembly: "b37", contig: "7", position: 140453136, reference: "A", alternate: "T" })
    ).toContain("A>T");
  });

  it("does not duplicate an existing chromosome prefix", () => {
    expect(chromosomeLabel("7")).toBe("chr7");
    expect(chromosomeLabel("chr7")).toBe("chr7");
  });

  it("chunks sequences for the focused base display", () => {
    expect(sequenceChunks("ACGTACGT", 4)).toEqual(["ACGT", "ACGT"]);
  });

  it("marks the selected allele on reference and edited sequence tracks", () => {
    const variant = {
      key: { assembly: "b37", contig: "1", position: 3, reference: "C", alternate: "T" },
      haplotype1Alt: true,
      haplotype2Alt: false,
      unphasedAlt: false,
      origin: "edited" as const,
      editIds: [],
      sourceInfo: {}
    };
    expect(sequenceDisplayParts("AACCGG", 1, 6, [variant], "reference", variant.key))
      .toContainEqual({ text: "C", role: "reference", selected: true });
    expect(sequenceDisplayParts("AATCGG", 1, 6, [variant], "one", variant.key))
      .toContainEqual({ text: "T", role: "alternate", selected: true });
    expect(sequenceDisplayParts("AACCGG", 1, 6, [variant], "two", variant.key))
      .toEqual([{ text: "AACCGG", role: "plain", selected: false }]);
  });

  it("creates safe project directory names", () => {
    expect(projectSlug("BRAF audition #1")).toBe("braf-audition-1");
  });

  it("finds a selected sample beyond the first 250 cohort columns", () => {
    const samples = Array.from({ length: 2505 }, (_, index) => `DGW_SYNTH_${String(index + 1).padStart(4, "0")}`);
    expect(filterSamples(samples, "2048")).toEqual(["DGW_SYNTH_2048"]);
    expect(filterSamples(samples, "")).toHaveLength(250);
  });
});
