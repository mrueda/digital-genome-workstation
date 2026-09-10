import { describe, expect, it } from "vitest";
import type { EffectiveVariant } from "./types";
import { refreshedAlleleFocus } from "./alleleFocus";

const context = { contig: "7", start: 100, end: 200 };
const selected: EffectiveVariant = {
  key: { assembly: "b37", contig: "7", position: 150, reference: "A", alternate: "T" },
  haplotype1Alt: true, haplotype2Alt: false, unphasedAlt: false,
  origin: "observed", editIds: [], sourceInfo: {}
};
const other = { ...selected, key: { ...selected.key, position: 110 } };
describe("allele focus across refreshes", () => {
  it("preserves an unchanged selection's object identity and staged form", () => {
    expect(refreshedAlleleFocus(selected, [other, structuredClone(selected)], context)).toBe(selected);
  });
  it("keeps the locus when restoration removes the ALT", () => {
    expect(refreshedAlleleFocus(selected, [other], context)).toBe(selected);
  });
  it("follows the exact source allele through replacement and undo", () => {
    const replacement = { ...selected, sourceKey: selected.key, key: { ...selected.key, alternate: "C" }, editIds: ["edit"] };
    expect(refreshedAlleleFocus(selected, [other, replacement], context)).toBe(replacement);
    expect(refreshedAlleleFocus(replacement, [other, selected], context)).toBe(selected);
  });
  it("does not select another ALT or chromosome copy at the same position", () => {
    const unrelated = { ...selected, key: { ...selected.key, alternate: "G" } };
    expect(refreshedAlleleFocus(selected, [unrelated], context)).toBe(selected);
    const otherCopy = { ...unrelated, sourceKey: selected.key, haplotype1Alt: false, haplotype2Alt: true };
    expect(refreshedAlleleFocus(selected, [otherCopy], context)).toBe(selected);
  });
  it("chooses an available allele when deliberately navigating elsewhere", () => {
    expect(refreshedAlleleFocus(selected, [other], { ...context, end: 120 })).toBe(other);
    expect(refreshedAlleleFocus(undefined, [], context)).toBeUndefined();
  });
  it("does not follow a different unphased genotype slot", () => {
    const first = { ...selected, haplotype1Alt: false, unphasedAlt: true, unphasedSlot: 1 };
    const second = { ...first, sourceKey: first.key, key: { ...first.key, alternate: "C" }, unphasedSlot: 2 };
    expect(refreshedAlleleFocus(first, [second], context)).toBe(first);
  });
});
