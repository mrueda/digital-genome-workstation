export interface ComparedImpact {
  before: number;
  after: number;
}

/** Bounded to the same rows as the comparison table; no inferred scores for missing evidence. */
export function ComparisonImpactChart({ rows, onSelect }: {
  rows: Array<{ id: string; label: string; impact?: ComparedImpact }>;
  onSelect: (id: string) => void;
}) {
  if (!rows.length) return null;
  const scored = rows.flatMap(row => row.impact ? [row.impact] : []);
  const mean = (side: "before" | "after") => scored.length
    ? (scored.reduce((sum, pair) => sum + pair[side], 0) / scored.length).toFixed(2) : "—";
  return <figure className="comparison-impact-chart">
    <figcaption><strong>Impact category score · Source {mean("before")} → Current {mean("after")}</strong>
      <span>Mean of {scored.length} evaluated ALT pairs · not whole-track burden</span></figcaption>
    <div className="comparison-impact-axis"><span>Higher +1</span><span>Same 0</span><span>Lower −1</span></div>
    <div className="comparison-impact-marks" role="group" aria-label="Impact changes by position">
      {rows.map(row => {
        const delta = row.impact ? row.impact.after - row.impact.before : undefined;
        const tone = delta === undefined ? "unknown" : delta > 0 ? "higher" : delta < 0 ? "lower" : "same";
        const description = delta === undefined ? "Not scored" : `Impact change ${delta > 0 ? "+" : ""}${delta.toFixed(2)}`;
        return <button key={row.id} className={`comparison-impact-mark ${tone}`} onClick={() => onSelect(row.id)}
          title={`${row.label} · ${description}`} aria-label={`${row.label} · ${description}`}>
          <i style={{ bottom: `${delta === undefined ? 8 : 50 + delta * 42}%` }}>{delta === undefined ? "◇" : "●"}</i>
        </button>;
      })}
    </div>
    <div className="comparison-impact-legend">Position order → · orange: higher · cyan: lower · grey: same · ◇ not scored. Different consequences can have the same score.</div>
  </figure>;
}
