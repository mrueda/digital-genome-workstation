import { describe, expect, it } from "vitest";
import { formatRecoveryReport } from "./ApplicationErrorBoundary";

describe("application recovery report", () => {
  it("includes the failure, time, and React component context", () => {
    const error = new Error("render failed");
    const report = formatRecoveryReport(error, "\n    at Workstation", "2026-09-03T18:30:00.000Z");
    expect(report).toContain("Digital Genome Workstation interface error");
    expect(report).toContain("2026-09-03T18:30:00.000Z");
    expect(report).toContain("Message: render failed");
    expect(report).toContain("at Workstation");
  });
});
