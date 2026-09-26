import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { EvidenceCard } from "./EvidenceCard";
import { annotationLabels, clinicalTone, clinvarReviewStars, evidenceProvider } from "./evidenceFields";

describe("database annotation display", () => {
  it("uses device identity even when a release name does not name ClinVar", () => {
    expect(evidenceProvider("2025-03-12", "org.dgw.builtin.clinvar")).toBe("clinvar");
  });
  it("splits classification pipes but preserves slash combinations and counts", () => {
    expect(annotationLabels("clinvar", "CLNSIG", "Pathogenic/Likely_pathogenic|risk_factor")?.map(v => v.text))
      .toEqual(["Pathogenic/Likely pathogenic", "risk factor"]);
    expect(annotationLabels("clinvar", "CLNSIGCONF", "Uncertain_significance(2)|Benign(1)")?.map(v => v.text))
      .toEqual(["Uncertain significance(2)", "Benign(1)"]);
    expect(clinicalTone("Conflicting_classifications_of_pathogenicity")).toBe("conflicting");
    expect(clinicalTone("not_pathogenic")).toBe("neutral");
    expect(clinicalTone("Pathogenic,protective")).toBe("neutral");
  });
  it("keeps ontology ID and effect together and leaves malformed values intact", () => {
    const result = annotationLabels("clinvar", "MC", "SO:0001583|missense_variant,SO:0001627|intron_variant,unexpected|a|b");
    expect(result?.map(v => v.text)).toEqual(["missense variant · SO:0001583", "intron variant · SO:0001627", "unexpected|a|b"]);
    expect(result?.[0].original).toBe("SO:0001583|missense_variant");
  });
  it("does not split commas in condition names or discard gene identifiers", () => {
    expect(annotationLabels("clinvar", "CLNDN", "Condition,_type_1|not_provided")?.map(v => v.text)).toEqual(["Condition, type 1", "not provided"]);
    expect(annotationLabels("clinvar", "GENEINFO", "BRAF:673|TEST:123")?.map(v => v.text)).toEqual(["BRAF:673", "TEST:123"]);
  });
  it("assigns review stars only to recognised complete values, not substrings", () => {
    expect(clinvarReviewStars("practice_guideline", "CLNREVSTAT")).toBe(4);
    expect(clinvarReviewStars("reviewed_by_expert_panel", "CLNREVSTAT")).toBe(3);
    expect(clinvarReviewStars("criteria_provided,_multiple_submitters,_no_conflicts", "CLNREVSTAT")).toBe(2);
    expect(clinvarReviewStars("criteria_provided,_conflicting_classifications", "CLNREVSTAT")).toBe(1);
    expect(clinvarReviewStars("no_assertion_criteria_provided", "CLNREVSTAT")).toBe(0);
    expect(clinvarReviewStars("criteria_provided,_multiple_submitters", "SCIREVSTAT")).toBe(2);
    expect(clinvarReviewStars("criteria_provided,_multiple_submitters", "CLNREVSTAT")).toBeUndefined();
    expect(clinvarReviewStars("reviewed_by_expert_panel|unknown", "CLNREVSTAT")).toBeUndefined();
    expect(clinvarReviewStars(".", "CLNREVSTAT")).toBeUndefined();
  });
  it("preserves unknown fields", () => {
    expect(annotationLabels("clinvar", "FUTURE", "a|b,c&d")).toBeUndefined();
    expect(annotationLabels("cosmic", "FUTURE", "A|B")).toBeUndefined();
    const html = renderToStaticMarkup(createElement(EvidenceCard, { deviceId: "org.dgw.builtin.clinvar", evidence: {
      source: "ClinVar", status: "found", records: [{ CLNSIG: "Uncertain_significance", FUTURE: "a|b,c&d", raw: "original record" }]
    } }));
    expect(html).toContain("Additional annotations");
    expect(html).toContain("a|b,c&amp;d");
    expect(html).toContain("original record");
    expect(html).toContain("annotation-uncertain");
    expect(html).not.toContain("impact-high");
  });
  it("formats COSMIC scalar fields without splitting values or assigning clinical meaning", () => {
    expect(annotationLabels("cosmic", "GENE", "A|B")).toEqual([{ original: "A|B", text: "A|B" }]);
    const html = renderToStaticMarkup(createElement(EvidenceCard, { deviceId: "org.dgw.builtin.cosmic", evidence: {
      source: "v92", status: "found", records: [{ id: "COSV_TEST", GENE: "BRAF_ENST_TEST", HGVSC: "ENST_TEST:c.123A>G", HGVSP: "p.Test", CNT: "0", FUTURE: "a|b,c", raw: "Synthetic COSMIC record" }]
    } }));
    expect(html).toContain("Reported samples");
    expect(html).toContain("not a population frequency or severity score");
    expect(html).toContain("BRAF_ENST_TEST");
    expect(html).toContain("ENST_TEST:c.123A&gt;G");
    expect(html).toContain("a|b,c");
    expect(html).toContain("Synthetic COSMIC record");
    expect(html).not.toContain("annotation-pathogenic");
    expect(html).not.toContain("annotation-stars");
    expect(html.indexOf("Gene</dt>")).toBeLessThan(html.indexOf("Record ID</dt>"));
  });
});
