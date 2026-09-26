/** Shared labels for predicted effects, not clinical classifications. */
export function PredictionTerms({ values, kind }: { values: string[]; kind: "gene" | "effect" | "impact" }) {
  const unique = [...new Set(values.flatMap(value => value.split("&")).map(value => value.trim()).filter(Boolean))];
  if (!unique.length) return <span className="prediction-unknown">—</span>;
  const term = (value: string) => <span key={value} className={`prediction-term${kind === "impact" ? ` impact-${value.toLowerCase()}` : ""}`} title={value}>
    {kind === "effect" ? value.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : value}
  </span>;
  return <div className={`prediction-terms prediction-${kind}`}>
    {unique.slice(0, 3).map(term)}
    {unique.length > 3 && <details><summary>+{unique.length - 3} more</summary>{unique.slice(3).map(term)}</details>}
  </div>;
}
