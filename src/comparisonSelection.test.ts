import { expect, test } from "vitest";
import { comparisonKeysFromIds } from "./comparisonSelection";

test("comparison keeps selected loci without requiring their former ALTs in the viewport", () => {
  expect(comparisonKeysFromIds(["b37:7:100:A:G", "b37:7:100:A:G", "b37:17:200:C:T"])).toEqual([
    { assembly: "b37", contig: "7", position: 100, reference: "A", alternate: "G" },
    { assembly: "b37", contig: "17", position: 200, reference: "C", alternate: "T" },
  ]);
});
test("marker decoding rejects invalid IDs and preserves contig delimiters", () => {
  expect(comparisonKeysFromIds(["bad", "b37:7:0:A:G", "b37:7:NaN:A:G"])).toEqual([]);
  expect(comparisonKeysFromIds(["b37:scaffold:one:100:A:G"])[0].contig).toBe("scaffold:one");
});
