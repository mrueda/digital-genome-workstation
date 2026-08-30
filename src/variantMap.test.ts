import { describe, expect, it } from "vitest";
import { sampleVariantMapMarks, variantMapTone, variantMapY } from "./variantMap";

describe("Variant Map model", () => {
  it("keeps missing values neutral rather than treating them as lower burden", () => {
    expect(variantMapTone(undefined)).toBe("unknown");
    expect(variantMapTone(Number.NaN)).toBe("unknown");
    expect(variantMapTone(0)).toBe("neutral");
    expect(variantMapTone(0.33)).toBe("higher");
    expect(variantMapTone(-0.33)).toBe("lower");
  });

  it("places higher deltas above and lower deltas below the source line", () => {
    expect(variantMapY(undefined, 1, 20, 100, 180)).toBe(100);
    expect(variantMapY(1, 1, 20, 100, 180)).toBe(20);
    expect(variantMapY(-1, 1, 20, 100, 180)).toBe(180);
    expect(variantMapY(0.5, 1, 20, 100, 180)).toBe(60);
  });

  it("samples dense regions evenly and retains both endpoints", () => {
    expect(sampleVariantMapMarks([0, 1, 2, 3, 4], 3)).toEqual([0, 2, 4]);
    expect(sampleVariantMapMarks([0, 1], 5)).toEqual([0, 1]);
  });
});
