import type { EvidenceResult } from "./types";

const names: Record<string, string> = {
  "org.dgw.builtin.cosmic": "COSMIC",
  "org.dgw.builtin.clinvar": "ClinVar",
  "org.dgw.builtin.variant-consequences": "Variant Consequences"
};

export function evidencePresentation(evidence: EvidenceResult, deviceId?: string) {
  const name = deviceId ? names[deviceId] : undefined;
  const cosmic = name === "COSMIC" || /cosmic/i.test(evidence.source);
  const missingData = evidence.status === "resourceUnavailable" && evidence.message === "data or index file is missing";
  const unconfigured = /not configured/i.test(evidence.source);
  return {
    title: name && unconfigured ? name : evidence.source,
    message: cosmic && missingData
      ? unconfigured
        ? "Optional COSMIC data is not configured for this project."
        : "COSMIC data or its index cannot be found for this project."
      : evidence.message,
    explanation: cosmic && missingData
      ? "DNA comparison and other available evidence still work. Check Settings → Resources → Optional resources · COSMIC. Existing projects keep their recorded resources."
      : undefined
  };
}
