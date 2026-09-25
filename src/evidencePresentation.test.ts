import { describe, expect, it } from "vitest";
import { evidencePresentation } from "./evidencePresentation";
import type { EvidenceResult } from "./types";

describe("unavailable evidence presentation", () => {
  const missing: EvidenceResult = { source: "Not configured", status: "resourceUnavailable", records: [], message: "data or index file is missing" };
  it("names optional COSMIC even when the release label is absent", () => {
    const display = evidencePresentation(missing, "org.dgw.builtin.cosmic");
    expect(display.title).toBe("COSMIC");
    expect(display.message).toContain("not configured for this project");
    expect(display.explanation).toContain("other available evidence still work");
  });
  it("does not mislabel a missing configured file or tool as unconfigured data", () => {
    expect(evidencePresentation({ ...missing, source: "COSMIC v100" }, "org.dgw.builtin.cosmic").message).toContain("cannot be found");
    expect(evidencePresentation({ ...missing, message: "tabix executable is missing" }, "org.dgw.builtin.cosmic").message).toBe("tabix executable is missing");
    expect(evidencePresentation(missing, "org.dgw.builtin.clinvar").explanation).toBeUndefined();
  });
});
