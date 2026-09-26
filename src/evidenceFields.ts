// Display-only adapters. Never use these labels to score or join annotations.
// ClinVar field grammar: installed VCF INFO headers (2025-03-12).
// Stars: https://www.ncbi.nlm.nih.gov/clinvar/docs/review_status/
// COSMIC field meanings: installed COSMICv92 VCF INFO headers.
// Unknown fields stay raw; never infer clinical severity from a COSMIC match.
export type EvidenceProvider = "clinvar" | "cosmic" | "prediction" | "other";
export function evidenceProvider(source: string, deviceId = ""): EvidenceProvider {
  if (deviceId === "org.dgw.builtin.clinvar" || /clinvar/i.test(source)) return "clinvar";
  if (deviceId === "org.dgw.builtin.cosmic" || /cosmic/i.test(source)) return "cosmic";
  if (deviceId === "org.dgw.builtin.variant-consequences" || source.startsWith("Consequence Predictor")) return "prediction";
  return "other";
}

const clinvarLabels: Record<string, string> = {
  CLNSIG: "Germline classification", CLNSIGCONF: "Conflicting classifications",
  CLNREVSTAT: "Germline review", CLNDN: "Reported conditions", GENEINFO: "Gene",
  MC: "Reported consequence", CLNHGVS: "Genomic change", id: "Variation ID",
  ONC: "Oncogenicity", ONCREVSTAT: "Oncogenicity review", ONCDN: "Oncogenicity conditions",
  SCI: "Somatic clinical impact", SCIREVSTAT: "Somatic review", SCIDN: "Somatic conditions"
};
const predictionLabels: Record<string, string> = {
  effect: "Consequence", impact: "Impact", geneName: "Gene", featureId: "Transcript",
  transcriptBiotype: "Transcript type", dnaChange: "DNA change", aminoAcidChange: "Protein change",
  annotationRelease: "Annotation release", engineVersion: "Engine version", engine: "Engine"
};
const cosmicLabels: Record<string, string> = {
  GENE: "Gene", HGVSC: "DNA change", HGVSP: "Protein change",
  CDS: "CDS change", AA: "Peptide change", HGVSG: "Genomic change",
  CNT: "Reported samples", id: "Record ID", GENOMIC_ID: "Genomic mutation ID",
  LEGACY_ID: "Legacy ID", STRAND: "Strand"
};
export function evidenceFieldLabel(provider: EvidenceProvider, key: string): string {
  return (provider === "clinvar" ? clinvarLabels : provider === "cosmic" ? cosmicLabels : provider === "prediction" ? predictionLabels : {})[key] ?? key;
}
export function isPrimaryEvidenceField(provider: EvidenceProvider, key: string): boolean {
  if (provider === "clinvar") return key in clinvarLabels;
  if (provider === "cosmic") return key in cosmicLabels;
  return !["annotationRelease", "engineVersion", "engine"].includes(key);
}
export function evidenceFieldOrder(provider: EvidenceProvider, key: string): number {
  if (provider !== "cosmic") return 0;
  const index = Object.keys(cosmicLabels).indexOf(key);
  return index < 0 ? 100 : index;
}
export const readableAnnotation = (value: string) => value.replace(/_/g, " ");
export type AnnotationTone = "neutral" | "pathogenic" | "benign" | "uncertain" | "conflicting";
export function clinicalTone(value: string): AnnotationTone {
  // Exact matches only: never turn an unfamiliar/combined term into "pathogenic".
  switch (value.toLowerCase()) {
    case "pathogenic": case "likely_pathogenic": case "pathogenic/likely_pathogenic": return "pathogenic";
    case "benign": case "likely_benign": case "benign/likely_benign": return "benign";
    case "uncertain_significance": return "uncertain";
    case "conflicting_classifications_of_pathogenicity": case "conflicting_interpretations_of_pathogenicity": return "conflicting";
    default: return "neutral";
  }
}
export function clinvarReviewStars(value: string, field: string): number | undefined {
  const common: Record<string, number> = {
    practice_guideline: 4, reviewed_by_expert_panel: 3,
    "criteria_provided,_single_submitter": 1, no_assertion_criteria_provided: 0,
    no_classification_provided: 0, no_classification_for_the_individual_variant: 0,
    no_assertion_provided: 0, no_interpretation_for_the_single_variant: 0
  };
  if (Object.hasOwn(common, value)) return common[value];
  if (field === "SCIREVSTAT") return value === "criteria_provided,_multiple_submitters" ? 2 : undefined;
  if (value === "criteria_provided,_multiple_submitters,_no_conflicts") return 2;
  if (["criteria_provided,_conflicting_classifications", "criteria_provided,_conflicting_interpretations"].includes(value)) return 1;
  return undefined;
}

export interface AnnotationLabel { text: string; original: string; tone?: AnnotationTone }
export function annotationLabels(provider: EvidenceProvider, key: string, value: string): AnnotationLabel[] | undefined {
  // COSMIC v92 fields are scalar. Preserve punctuation, identifiers and counts
  // verbatim rather than interpreting pipes/commas as independent records.
  if (provider === "cosmic" && key in cosmicLabels) return [{ original: value, text: value }];
  if (provider === "clinvar") {
    if (["CLNSIG", "CLNSIGCONF", "ONC", "SCI"].includes(key)) return value.split("|").map(original => ({ original, text: readableAnnotation(original), tone: key === "CLNSIG" ? clinicalTone(original) : "neutral" }));
    if (["CLNDN", "ONCDN", "SCIDN"].includes(key)) return value.split("|").map(original => ({ original, text: readableAnnotation(original) }));
    if (key === "MC") return value.split(",").map(original => {
      const match = /^(SO:\d+)\|([^|]+)$/.exec(original);
      return { original, text: match ? `${readableAnnotation(match[2])} · ${match[1]}` : original };
    });
    if (key === "GENEINFO") return value.split("|").map(original => ({ original, text: original }));
  }
  return undefined;
}
