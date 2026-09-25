import { useEffect, useRef, useState } from "react";
import type { EvidenceResult, VariantKey } from "./types";
import { AlleleEvidenceComparison } from "./AlleleEvidenceComparison";
import { dnaChanged, type ComparisonRow } from "./comparisonRows";
import { consequenceImpactSignal } from "./trackMeter";
import { ComparisonImpactChart, type ComparedImpact } from "./ComparisonImpactChart";
import { PredictionOutcomeSummary } from "./PredictionOutcomeSummary";

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
  const [impacts, setImpacts] = useState<Record<string, ComparedImpact>>({});
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [selectedId, setSelectedId] = useState<string>();
  const runId = useRef(0);
  useEffect(() => {
    runId.current++; setOutcomes({}); setImpacts({}); setProgress(undefined); setSelectedId(undefined); setFilter("changed");
    return () => { runId.current++; };
  }, [revision]);
  const changed = rows.filter(dnaChanged);
  const targets = changed.filter(row => row.source && row.current && !row.restored).slice(0, 200);
  const selected = rows.find(row => row.id === selectedId);
  const visible = rows.filter(row => filter === "all" || (filter === "referenceRestoration" ? row.restored : filter === "changed" ? dnaChanged(row) : outcomes[row.id] === filter));
  const running = Boolean(progress && progress.done < progress.total);
  async function evaluate() {
    const run = ++runId.current;
    let cursor = 0, done = 0;
    setOutcomes({}); setImpacts({}); setProgress({ done: 0, total: targets.length });
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (cursor < targets.length && run === runId.current) {
        const row = targets[cursor++];
        let outcome: Outcome = "missing";
        try {
          const [before, after] = await Promise.all([load(row.source!, [consequenceId], true), load(row.current!.key, [consequenceId], true)]);
          outcome = predictionDifference(before[consequenceId], after[consequenceId]);
          if (run === runId.current && outcome !== "missing") {
            const a = consequenceImpactSignal(before[consequenceId]);
            const b = consequenceImpactSignal(after[consequenceId]);
            if (a !== undefined && b !== undefined) setImpacts(current => ({ ...current, [row.id]: { before: a, after: b } }));
          }
        } catch { /* Missing evidence is not an unchanged prediction. */ }
        if (run !== runId.current) return;
        setOutcomes(current => ({ ...current, [row.id]: outcome }));
        setProgress({ done: ++done, total: targets.length });
      }
    }));
  }
  return <section className="comparison-workspace" aria-label="Compare source and candidate">
    <header className="prediction-intro"><div><h2>Did the edits change predicted consequences?</h2><p>Source → {trackName} · {scope} · visible region, not selected alleles</p></div></header>
    <div className="prediction-run-row"><div><b>Inspect prediction differences behind the track score</b><p>Monitor summarises the score; this view compares individual Consequence Predictor predictions. Different consequences can have the same score.</p></div>
      <button className="button primary" onClick={() => { void evaluate(); }} disabled={running || !changed.length || !deviceIds.includes(consequenceId)}>{running ? "Comparing consequences…" : "Compare consequences"}</button>
    </div>
    <p className="prediction-coverage">{targets.length} eligible ALT pairs · up to 200 per region comparison. REF restorations are listed separately.</p>
    {running && <p role="status">{progress!.done} / {progress!.total} ALT pairs compared…</p>}
    {progress && !running && <>
    <PredictionOutcomeSummary counts={progress ? { different: Object.values(outcomes).filter(v => v === "different").length, same: Object.values(outcomes).filter(v => v === "same").length, missing: Object.values(outcomes).filter(v => v === "missing").length, referenceRestoration: changed.filter(row => row.restored).length } : undefined} unit="allele rows" filter={filter} onFilter={value => setFilter(value || "changed")} />
    <details className="comparison-details"><summary>Impact chart · optional numerical view</summary><ComparisonImpactChart rows={changed.slice(0, 200).map(row => {
      const key = row.source ?? row.current!.key;
      return { id: row.id, label: `${key.contig}:${key.position} ${row.source?.alternate ?? "?"} → ${row.restored ? key.reference : row.current?.key.alternate ?? "?"}`, impact: impacts[row.id] };
    })} onSelect={setSelectedId} /></details>
    </>}
    {!deviceIds.includes(consequenceId) && <p className="comparison-scope-note">Enable Consequence Predictor in the rack to compare predictions. DNA differences remain available.</p>}
    {changed.length === 0 && <p className="prediction-empty">No applied DNA changes in this region. Edit the track first, or choose All chromosomes to look elsewhere.</p>}
    {progress && !running && <>
    <div className="comparison-actions">
      <label>Show <select aria-label="Comparison filter" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="changed">Changed alleles</option><option value="all">All alleles in view</option>
        <option value="different">Different predictions</option><option value="same">Same predictions</option><option value="missing">Missing evidence</option>
        <option value="referenceRestoration">REF restorations</option>
      </select></label>
      {progress && <span role="status">{progress.done} / {progress.total} compared</span>}
    </div>
    <div className="comparison-table-scroll"><table><thead><tr><th>Position</th><th>Source ALT</th><th>Current ALT</th><th>Prediction comparison</th><th>Inspect</th></tr></thead>
      <tbody>{visible.slice(0, 200).map(row => { const key = row.source ?? row.current!.key; return <tr key={row.id} aria-selected={selectedId === row.id}>
        <td>{key.contig}:{key.position.toLocaleString()}<small className="comparison-copy">{row.copy === "Unphased" ? "Copy unknown (unphased)" : `Copy ${row.copy}`}</small></td><td><code>{row.source?.alternate ?? "Unknown"}</code></td>
        <td><code>{row.restored ? `${key.reference} (REF)` : row.current?.key.alternate ?? "Unavailable"}</code></td>
        <td>{row.restored ? "REF restored · not ALT-scored" : !dnaChanged(row) ? "Same allele" : outcomes[row.id] === "different" ? "Different prediction" : outcomes[row.id] === "same" ? "Same prediction" : outcomes[row.id] === "missing" ? "Missing evidence" : "Not compared"}</td>
        <td><button className="button secondary" onClick={() => setSelectedId(row.id)} aria-label={`Compare allele ${key.contig}:${key.position}`} aria-pressed={selectedId === row.id}>Compare evidence</button> <button className="button secondary" onClick={() => onOpen(row)} aria-label={`Open allele ${key.contig}:${key.position}`} title="Switch to Edit and open this allele">Edit allele ↗</button></td>
      </tr>; })}</tbody></table></div>
    {visible.length === 0 && <p role="status">{rows.length === 0 ? "No allele rows are loaded in this region. Navigate to a variant or use DNA changes." : filter === "changed" ? "No DNA changes in the loaded region. Check DNA changes for changes elsewhere." : running ? "Comparison is running; no matching results yet." : "No compared alleles match this filter."}</p>}
    {visible.length > 200 && <p>Showing the first 200 rows. Narrow the genomic view to inspect others.</p>}
    {selected && <AlleleEvidenceComparison source={selected.source} current={selected.current?.key} restored={selected.restored} deviceIds={deviceIds} revision={revision} load={load} />}
    </>}
    <details className="comparison-details"><summary>What is being compared?</summary><p className="muted">Applied track edits, including unconsolidated blocks and layers; not unapplied proposals. Follows the chromosome view, not allele selection. Compares up to 200 changed ALT pairs using transcript, consequence and impact category. Same predictions do not prove equal function. REF restorations are separate. The optional chart uses maximum transcript impact: HIGH 1, MODERATE 0.67, LOW 0.33, MODIFIER 0.1. Its means include only pairs with evidence on both sides, not missing evidence or REF restorations. Different consequences can share a score. This is not disease risk.</p></details>
  </section>;
}
