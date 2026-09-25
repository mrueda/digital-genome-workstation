const outcomes = [
  ["different", "Different predictions", "Transcript consequences differ", "different"],
  ["same", "Same predictions", "Matching predictions, not proof of equal function", "same"],
  ["missing", "Missing evidence", "Cannot compare both sides", "missing"],
  ["referenceRestoration", "REF restorations", "Kept separate from ALT comparisons", "restored"]
] as const;

export function PredictionOutcomeSummary({ counts, unit, filter, onFilter }: {
  counts?: Record<string, number>; unit: string; filter: string; onFilter: (filter: string) => void;
}) {
  return <div className="prediction-outcome-summary" aria-label="Prediction outcomes">
    {outcomes.map(([id, label, description, tone]) => <button type="button" key={id} className={`prediction-outcome ${tone}`} disabled={!counts} aria-pressed={filter === id} onClick={() => onFilter(filter === id ? "" : id)}>
      <span>{label}</span><b>{counts ? (counts[id] ?? 0).toLocaleString() : "—"}<small>{counts?.[id] === 1 ? unit === "loci" ? "locus" : "allele row" : unit}</small></b><small>{description}</small>
    </button>)}
  </div>;
}
