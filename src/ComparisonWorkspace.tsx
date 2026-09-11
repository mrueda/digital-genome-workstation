import { useEffect, useRef, useState } from "react";
import type { EvidenceResult, VariantKey } from "./types";
import { AlleleEvidenceComparison } from "./AlleleEvidenceComparison";
import { dnaChanged, type ComparisonRow } from "./comparisonRows";

type Outcome = "different" | "same" | "missing";
type Evidence = Record<string, EvidenceResult>;
const consequenceId = "org.dgw.builtin.variant-consequences";
export function predictionDifference(before?: EvidenceResult, after?: EvidenceResult): Outcome {
  const fingerprint = (result?: EvidenceResult) => result?.status === "found" && result.records.length > 0
    && result.records.every(row => row.effect && row.impact)
    ? JSON.stringify([...new Set(result.records.map(row => JSON.stringify([row.featureId ?? "", row.effect, row.impact])))].sort()) : undefined;
  const a = fingerprint(before), b = fingerprint(after);
  return a === undefined || b === undefined ? "missing" : a === b ? "same" : "different";
}
export function ComparisonWorkspace({ rows, trackName, scope, revision, deviceIds, load, onBack, onOpen }: {
  rows: ComparisonRow[]; trackName: string; scope: string; revision: string; deviceIds: string[];
  load: (key: VariantKey, ids: string[], cached: boolean) => Promise<Evidence>;
  onBack: () => void; onOpen: (row: ComparisonRow) => void;
}) {
  const [filter, setFilter] = useState("changed");
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [selectedId, setSelectedId] = useState<string>();
  const runId = useRef(0);
  useEffect(() => {
    runId.current++; setOutcomes({}); setProgress(undefined); setSelectedId(undefined);
    return () => { runId.current++; };
  }, [revision]);
  const changed = rows.filter(dnaChanged);
  const targets = changed.filter(row => row.source && row.current && !row.restored).slice(0, 200);
  const selected = rows.find(row => row.id === selectedId);
  const visible = rows.filter(row => filter === "all" || (filter === "changed" ? dnaChanged(row) : outcomes[row.id] === filter));
  const running = Boolean(progress && progress.done < progress.total);
  async function evaluate() {
    const run = ++runId.current;
    let cursor = 0, done = 0;
    setOutcomes({}); setProgress({ done: 0, total: targets.length });
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (cursor < targets.length && run === runId.current) {
        const row = targets[cursor++];
        let outcome: Outcome = "missing";
        try {
          const [before, after] = await Promise.all([load(row.source!, [consequenceId], true), load(row.current!.key, [consequenceId], true)]);
          outcome = predictionDifference(before[consequenceId], after[consequenceId]);
        } catch { /* Missing evidence is not an unchanged prediction. */ }
        if (run !== runId.current) return;
        setOutcomes(current => ({ ...current, [row.id]: outcome }));
        setProgress({ done: ++done, total: targets.length });
      }
    }));
  }
  return <section className="comparison-workspace" aria-label="Compare source and candidate">
    <header><div><h2>What changed?</h2><p>Imported source → {trackName}</p></div><button className="button secondary" onClick={onBack}>Back to tracks</button></header>
    <p className="muted">{scope} · loaded region only, not the whole track. {rows.length} allele rows · {changed.length} DNA changes.</p>
    <div className="comparison-actions">
      <label>Show <select aria-label="Comparison filter" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="changed">DNA changes</option><option value="all">All loaded alleles</option>
        <option value="different">Different predictions</option><option value="same">Same predictions</option><option value="missing">Missing evidence</option>
      </select></label>
      <button className="button primary" onClick={() => { void evaluate(); }} disabled={running || !targets.length || !deviceIds.includes(consequenceId)}>Compare predictions</button>
      {progress && <span role="status">{progress.done} / {progress.total} compared</span>}
    </div>
    <p className="muted">Compares transcript, consequence and impact for up to 200 changed ALT pairs, using active Variant Consequences. REF restorations are separate; an unchanged prediction does not mean an unchanged biological effect.</p>
    <div className="comparison-table-scroll"><table><thead><tr><th>Position</th><th>Source ALT</th><th>Current</th><th>Prediction comparison</th><th>Inspect</th></tr></thead>
      <tbody>{visible.slice(0, 200).map(row => { const key = row.source ?? row.current!.key; return <tr key={row.id} aria-selected={selectedId === row.id}>
        <td>{key.contig}:{key.position.toLocaleString()}<small className="comparison-copy">{row.copy === "Unphased" ? "Copy unknown (unphased)" : `Copy ${row.copy}`}</small></td><td><code>{row.source?.alternate ?? "Unknown"}</code></td>
        <td><code>{row.restored ? `${key.reference} (REF)` : row.current?.key.alternate ?? "Unavailable"}</code></td>
        <td>{row.restored ? "REF restored · not ALT-scored" : !dnaChanged(row) ? "Same allele" : outcomes[row.id] === "different" ? "Different prediction" : outcomes[row.id] === "same" ? "Same prediction" : outcomes[row.id] === "missing" ? "Missing evidence" : "Not compared"}</td>
        <td><button className="button secondary" onClick={() => setSelectedId(row.id)} aria-label={`Compare allele ${key.contig}:${key.position}`}>Evidence</button> <button className="button secondary" onClick={() => onOpen(row)} aria-label={`Open allele ${key.contig}:${key.position}`}>Go to allele</button></td>
      </tr>; })}</tbody></table></div>
    {visible.length === 0 && <p>No rows in this filter. Compare predictions to populate prediction filters.</p>}
    {visible.length > 200 && <p>Showing the first 200 rows. Narrow the genomic view to inspect others.</p>}
    {selected && <AlleleEvidenceComparison source={selected.source} current={selected.current?.key} restored={selected.restored} deviceIds={deviceIds} revision={revision} load={load} />}
  </section>;
}
