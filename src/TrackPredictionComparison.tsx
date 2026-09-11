import { useEffect, useState } from "react";
import { api } from "./api";
import { EvidenceCard } from "./EvidenceCard";
import type { BackgroundJob, PredictionComparisonReport, PredictionComparisonPage, PredictionComparisonRow, TrackComparisonLocus, VariantKey } from "./types";

const labels: Record<string, string> = { different: "Different predictions", same: "Same predictions", missing: "Missing evidence", referenceRestoration: "REF restorations" };
const evidenceKey = (key: VariantKey) => [key.assembly, key.contig, key.position, key.reference, key.alternate].join("|");
export function TrackPredictionComparison({ projectPath, trackId, revision, deviceIds, workerThreads, onBack, onFocus }: {
  projectPath: string; trackId: string; revision: string; deviceIds: string[]; workerThreads: number; onBack: () => void; onFocus: (locus: TrackComparisonLocus) => void;
}) {
  const [job, setJob] = useState<BackgroundJob<PredictionComparisonReport>>();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState(""); const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ key: string; page: PredictionComparisonPage }>();
  const [selected, setSelected] = useState<PredictionComparisonRow>();
  const running = job?.status === "queued" || job?.status === "running";
  const key = JSON.stringify([job?.id, revision, [...deviceIds].sort(), filter, offset, retry]);
  const page = result?.key === key ? result.page : undefined;
  useEffect(() => {
    let cancelled = false;
    void api.listBackgroundJobs(projectPath, 100).then(jobs => {
      if (!cancelled) setJob(current => current ?? jobs.find(item => item.trackId === trackId && item.operation === "trackPredictionComparison") as BackgroundJob<PredictionComparisonReport> | undefined);
    }).catch(err => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [projectPath, trackId]);
  useEffect(() => {
    if (!job || !running) return;
    let cancelled = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return; pending = true;
      void api.backgroundJob<PredictionComparisonReport>(projectPath, job.id).then(next => { if (!cancelled) { setJob(next); setError(""); } }).catch(err => { if (!cancelled) setError(String(err)); }).finally(() => { pending = false; });
    }, 750);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job?.id, running, projectPath]);
  useEffect(() => {
    setSelected(undefined);
    if (job?.status !== "completed") return;
    let cancelled = false;
    void api.predictionComparisonPage(projectPath, job.id, deviceIds, filter || undefined, offset)
      .then(page => { if (!cancelled) { setResult({ key, page }); setError(""); } }).catch(err => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [key, job?.status, projectPath]);
  async function start() {
    setSubmitting(true); setError("");
    try { setJob(await api.startPredictionComparison(projectPath, trackId, deviceIds, workerThreads)); setOffset(0); setSelected(undefined); }
    catch (err) { setError(String(err)); } finally { setSubmitting(false); }
  }
  return <section className="comparison-workspace" aria-label="Whole track prediction comparison">
    <header><div><h2>Which changes altered predictions?</h2><p>Independent allele-copy consequences at changed imported loci</p></div><button onClick={onBack}>Back to tracks</button></header>
    <div className="comparison-actions"><button className="button primary" disabled={running || submitting || !deviceIds.includes("org.dgw.builtin.variant-consequences")} onClick={() => { void start(); }}>{submitting ? "Submitting…" : "Compare track predictions"}</button>
      {running && <button onClick={() => { void api.cancelBackgroundJob(projectPath, job!.id).then(next => setJob(next as BackgroundJob<PredictionComparisonReport>)).catch(err => setError(String(err))); }}>Cancel comparison</button>}
      {job && <span role="status">{job.progress}% · {job.message}</span>}
    </div>
    {running && <progress aria-label="Prediction comparison progress" max={100} value={job?.progress ?? 0} />}
    <p className="muted">Uses active Variant Consequences, not a new burden score. Same predictions do not establish equivalent biological effects. REF reductions take precedence and remain separate, including loci that also contain replacement ALTs. Other Evidence devices remain available in the editor.</p>
    {!deviceIds.includes("org.dgw.builtin.variant-consequences") && <p>Enable Variant Consequences in the rack to run this comparison.</p>}
    {error && <p role="alert">{error}</p>}
    {error && job?.status === "completed" && <button onClick={() => { setError(""); setRetry(value => value + 1); }}>Retry loading results</button>}
    {job?.error && <p role="alert">{job.error}</p>}
    {page?.stale && <p role="alert">Results are outdated: track or evidence inputs changed. Run comparison again.</p>}
    {job?.status === "completed" && !page && !error && <p role="status">Loading comparison results…</p>}
    {page && !page.stale && <>
      <p>{Object.entries(job?.result?.counts ?? {}).map(([name, count]) => `${labels[name] ?? name}: ${count.toLocaleString()}`).join(" · ")}</p>
      <div className="comparison-actions"><label>Show <select aria-label="Prediction result filter" value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}><option value="">All results</option>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>Previous results</button><button disabled={offset + 200 >= page.total} onClick={() => setOffset(offset + 200)}>Next results</button><span>{page.total.toLocaleString()} matching loci</span>
      </div>
      <div className="comparison-table-scroll"><table><thead><tr><th>Locus</th><th>Source ALTs</th><th>Current ALTs</th><th>Result</th><th>Inspect</th></tr></thead><tbody>{page.rows.map(row => <tr key={`${row.locus.contig}:${row.locus.position}:${row.locus.reference}`}>
        <td>{row.locus.contig}:{row.locus.position.toLocaleString()}</td><td>{row.locus.source.map(v => v.key.alternate).join(" / ")}</td><td>{row.locus.current.map(v => v.key.alternate).join(" / ") || "No ALT"}</td><td>{labels[row.outcome]}</td><td><button onClick={() => setSelected(row)}>Evidence</button> <button onClick={() => onFocus(row.locus)}>Go to locus</button></td>
      </tr>)}</tbody></table></div>
      {page.rows.length === 0 && <p>No loci match this result filter.</p>}
      {selected && <div className="prediction-evidence-pair">{(["source", "current"] as const).map(side => <section key={side} aria-label={`${side} prediction evidence`}><h3>{side === "source" ? "Source" : "Current"} · saved prediction</h3>{selected.locus[side].map(variant => <div key={evidenceKey(variant.key)}><h4>{variant.key.reference} → {variant.key.alternate}</h4>{selected.evidence[evidenceKey(variant.key)] ? <EvidenceCard evidence={selected.evidence[evidenceKey(variant.key)]} /> : <p>Missing evidence</p>}</div>)}{selected.locus[side].length === 0 && <p>No ALT to score. This is not a benign classification.</p>}</section>)}</div>}
    </>}
  </section>;
}
