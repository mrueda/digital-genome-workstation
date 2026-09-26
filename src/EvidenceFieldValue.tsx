import { PredictionTerms } from "./PredictionTerms";
import { annotationLabels, clinvarReviewStars, readableAnnotation, type EvidenceProvider } from "./evidenceFields";

export function EvidenceFieldValue({ provider, field, value }: { provider: EvidenceProvider; field: string; value: string }) {
  if (value === ".") return <span className="annotation-missing">Not provided</span>;
  if (provider === "prediction" && ["effect", "impact", "geneName"].includes(field)) return <PredictionTerms kind={field === "geneName" ? "gene" : field as "effect" | "impact"} values={[value]} />;
  if (provider === "clinvar" && ["CLNREVSTAT", "ONCREVSTAT", "SCIREVSTAT"].includes(field)) {
    const stars = clinvarReviewStars(value, field);
    return <div className="annotation-review" title={value}>
      {stars !== undefined && <span className="annotation-stars" role="img" aria-label={`${stars} of 4 review stars`} title="ClinVar review status, not disease severity">{"★".repeat(stars)}{"☆".repeat(4 - stars)}</span>}
      <span>{readableAnnotation(value)}</span>
    </div>;
  }
  const labels = annotationLabels(provider, field, value);
  if (!labels) return <span className="annotation-original">{value}</span>;
  const render = (label: typeof labels[number], index: number) => <span key={index} title={label.original} className={`annotation-label annotation-${label.tone ?? "neutral"}`}>{label.text === "." ? "Not provided" : label.text}</span>;
  return <div className="annotation-labels" title={provider === "cosmic" && field === "CNT" ? "Sample count reported by COSMIC; not a population frequency or severity score." : undefined}>
    {labels.slice(0, 3).map(render)}
    {labels.length > 3 && <details><summary>+{labels.length - 3} more</summary>{labels.slice(3).map(render)}</details>}
  </div>;
}
