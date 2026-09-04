import { describe, expect, it } from "vitest";
import { effectiveScoringWeights, scoringInputState } from "./scoringInputs";

const inputs = [
  { id: "impact", sourceDeviceId: "consequence" },
  { id: "clinvar", sourceDeviceId: "clinvar" },
  { id: "sourceEvidence" }
];

describe("objective scoring inputs", () => {
  it("keeps exclusion separate from bypass", () => {
    const objective = { includedWeightIds: ["impact", "sourceEvidence"] };
    expect(scoringInputState(objective, inputs[0], new Set())).toBe("included");
    expect(scoringInputState(objective, inputs[1], new Set())).toBe("excluded");
    expect(scoringInputState(objective, inputs[0], new Set(["consequence"]))).toBe("bypassed");
  });

  it("uses zero effective weight without changing configured values", () => {
    const configured = { impact: 70, clinvar: 60, sourceEvidence: 20 };
    const effective = effectiveScoringWeights(
      configured,
      { includedWeightIds: ["impact", "clinvar", "sourceEvidence"] },
      inputs,
      new Set(["consequence"])
    );

    expect(effective).toEqual({ impact: 0, clinvar: 60, sourceEvidence: 20 });
    expect(configured).toEqual({ impact: 70, clinvar: 60, sourceEvidence: 20 });
  });

  it("defaults unknown or unlisted inputs to excluded", () => {
    expect(scoringInputState(undefined, { id: "futureDevice" }, new Set())).toBe("excluded");
    expect(effectiveScoringWeights(
      { impact: 70 },
      { includedWeightIds: [] },
      inputs,
      new Set()
    )).toEqual({ impact: 0, clinvar: 0, sourceEvidence: 0 });
  });

  it("keeps an included but unapplied device distinct and ineffective", () => {
    const objective = { includedWeightIds: ["impact", "clinvar", "sourceEvidence"] };
    const applied = new Set(["clinvar"]);
    expect(scoringInputState(objective, inputs[0], new Set(), applied)).toBe("notApplied");
    expect(effectiveScoringWeights(
      { impact: 70, clinvar: 60, sourceEvidence: 20 },
      objective,
      inputs,
      new Set(),
      applied
    )).toEqual({ impact: 0, clinvar: 60, sourceEvidence: 20 });
  });
});
