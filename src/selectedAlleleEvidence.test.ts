import { describe, expect, it } from "vitest";
import type { EvidenceResult } from "./types";
import {
  cacheStableEvidence,
  cachedEvidenceForDevices,
  missingEvidenceDeviceIds,
  selectionEvidenceKey,
  type SelectedAlleleEvidenceCache
} from "./selectedAlleleEvidence";

const found: EvidenceResult = { source: "Consequence Predictor", status: "found", records: [{ impact: "HIGH" }] };
const exactMiss: EvidenceResult = { source: "ClinVar", status: "noExactMatch", records: [] };

describe("selected-allele live evidence", () => {
  it("keys results by the exact normalized allele", () => {
    expect(selectionEvidenceKey({ assembly: "b37", contig: "7", position: 140453136, reference: "A", alternate: "T" }))
      .toBe("b37:7:140453136:A:T");
  });

  it("returns cached live results first and identifies only missing active devices", () => {
    const cache: SelectedAlleleEvidenceCache = new Map();
    cacheStableEvidence(cache, "allele", "consequence", found);
    cacheStableEvidence(cache, "allele", "clinvar", exactMiss);

    expect(cachedEvidenceForDevices(cache, "allele", ["consequence", "cosmic", "clinvar"]))
      .toEqual({ consequence: found, clinvar: exactMiss });
    expect(missingEvidenceDeviceIds(cache, "allele", ["consequence", "cosmic", "clinvar"]))
      .toEqual(["cosmic"]);
  });

  it("does not retain transient unavailable or error responses", () => {
    const cache: SelectedAlleleEvidenceCache = new Map();
    cacheStableEvidence(cache, "allele", "consequence", { source: "Consequence Predictor", status: "resourceUnavailable", records: [] });
    cacheStableEvidence(cache, "allele", "clinvar", { source: "ClinVar", status: "error", records: [] });

    expect(cache.get("allele")).toBeUndefined();
    expect(missingEvidenceDeviceIds(cache, "allele", ["consequence", "clinvar"]))
      .toEqual(["consequence", "clinvar"]);
  });
});
