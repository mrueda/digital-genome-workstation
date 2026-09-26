import { Fragment, useEffect, useState } from "react";
import { api } from "./api";
import { EvidenceCard } from "./EvidenceCard";
import { PredictionTerms } from "./PredictionTerms";
import { PredictionOutcomeSummary } from "./PredictionOutcomeSummary";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Play, LoaderCircle, MousePointer2, Square } from "lucide-react";
import type { BackgroundJob, PredictionComparisonReport, PredictionComparisonPage, PredictionComparisonRow, TrackComparisonLocus, VariantKey, VariantSelection } from "./types";

const labels: Record<string, string> = { different: "Different predictions", same: "Same predictions", missing: "Missing evidence", referenceRestoration: "REF restorations" };
const PAGE_SIZE = 200;
function ResultPagination({ total, offset, onPage, position }: { total: number; offset: number; onPage: (offset: number) => void; position: "top" | "bottom" }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.floor(offset / PAGE_SIZE) + 1;
  return <nav className="consequence-pagination" aria-label={`Consequence results pagination ${position}`}>
    <span>{total ? `${(offset + 1).toLocaleString()}–${Math.min(offset + PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()} loci` : "0 loci"}</span>
    <div>
      <button type="button" aria-label="First page" title="First page" disabled={offset === 0} onClick={() => onPage(0)}><ChevronFirst aria-hidden="true" /></button>
      <button type="button" aria-label="Previous page" title="Previous page" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft aria-hidden="true" /></button>
      <form onSubmit={event => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get("page")); if (Number.isFinite(value)) onPage((Math.max(1, Math.min(pages, Math.trunc(value))) - 1) * PAGE_SIZE); }}>
        <label>Page <input key={`${offset}:${total}`} name="page" aria-label="Page number" type="number" min={1} max={pages} step={1} defaultValue={current} disabled={!total} /></label><span>of {pages.toLocaleString()}</span><button type="submit" disabled={!total}>Go</button>
      </form>
      <button type="button" aria-label="Next page" title="Next page" disabled={current >= pages} onClick={() => onPage(offset + PAGE_SIZE)}><ChevronRight aria-hidden="true" /></button>
      <button type="button" aria-label="Last page" title="Last page" disabled={current >= pages} onClick={() => onPage((pages - 1) * PAGE_SIZE)}><ChevronLast aria-hidden="true" /></button>
    </div>
  </nav>;
}
const evidenceKey = (key: VariantKey) => [key.assembly, key.contig, key.position, key.reference, key.alternate].join("|");
function selectionKey(selection?: VariantSelection) {
  if (!selection) return "";
  return JSON.stringify([selection.kind, selection.trackId,
    selection.kind === "interval" ? [selection.contig, selection.start, selection.end] : null,
    (selection.kind === "explicit" ? selection.variants : selection.exclusions).map(evidenceKey).sort()]);
}
export interface ConsequenceViewState { job?: BackgroundJob<PredictionComparisonReport>; filter: string; offset: number; consequences?: string[]; impacts?: string[] }
export function TrackPredictionComparison({ projectPath, trackId, revision, deviceIds, workerThreads, onBack, onFocus, selection, selectedCount, savedView, onRemember, currentOnly = false }: {
  projectPath: string; trackId: string; revision: string; deviceIds: string[]; workerThreads: number; onBack: () => void; onFocus: (locus: TrackComparisonLocus) => void;
  selection: VariantSelection; selectedCount: number;
  savedView?: ConsequenceViewState; onRemember?: (state: ConsequenceViewState) => void;
  currentOnly?: boolean;
}) {
  const operation = currentOnly ? "selectionPrediction" : "trackPredictionComparison";
  const resultLabels = currentOnly ? { predicted: "Predicted", missing: "Unavailable prediction", reference: "No current ALT" } : labels;
  const [job, setJob] = useState<BackgroundJob<PredictionComparisonReport> | undefined>(savedView?.job);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retry, setRetry] = useState(0);
  const [consequence, setConsequence] = useState<string[]>(savedView?.consequences ?? []);
  const [impact, setImpact] = useState<string[]>(savedView?.impacts ?? []);
  const [filter, setFilter] = useState(savedView?.filter ?? ""); const [offset, setOffset] = useState(savedView?.offset ?? 0);
  useEffect(() => { onRemember?.({ job, filter, offset, consequences: consequence, impacts: impact }); }, [job, filter, offset, consequence, impact, onRemember]);
  const [result, setResult] = useState<{ key: string; page: PredictionComparisonPage }>();
  const [selected, setSelected] = useState<PredictionComparisonRow>();
  const running = job?.status === "queued" || job?.status === "running";
  const key = JSON.stringify([job?.id, revision, [...deviceIds].sort(), filter, offset, retry, consequence, impact]);
  const page = result?.key === key ? result.page : undefined;
  useEffect(() => {
    let cancelled = false;
    void api.listBackgroundJobs(projectPath, 100).then(jobs => {
      if (!cancelled) setJob(current => current ?? jobs.find(item => item.trackId === trackId && item.operation === operation && selectionKey((item.request as { selection?: VariantSelection })?.selection) === selectionKey(selection)) as BackgroundJob<PredictionComparisonReport> | undefined);
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
    void api.predictionComparisonPage(projectPath, job.id, deviceIds, filter || undefined, offset, consequence, impact)
      .then(page => { if (!cancelled) { setResult({ key, page }); if (currentOnly && page.total === 1 && !page.stale) setSelected(page.rows[0]); setError(""); } }).catch(err => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [key, job?.status, projectPath]);
  async function start() {
    setSubmitting(true); setCancelling(false); setError("");
    try { setJob(await api.startPredictionComparison(projectPath, trackId, deviceIds, workerThreads, selection, currentOnly)); setOffset(0); setSelected(undefined); }
    catch (err) { setError(String(err)); } finally { setSubmitting(false); }
  }
  return <section className={`comparison-workspace${currentOnly ? " selection-predictor" : ""}`} aria-label={currentOnly ? "Consequence selection report" : "Selected consequences comparison"}>
    {!currentOnly && <header className="prediction-intro"><div><h2>Did the edits change predicted consequences?</h2><p>Source → Current · selected positions only</p></div></header>}
    <div className="prediction-run-row"><div>{currentOnly ? <><b>Detailed selection report</b><p>Full transcript details for current ALT alleles at the selected positions.</p></> : <><b>{selectedCount.toLocaleString()} alleles selected</b><p>Compares changed loci within your selection using Consequence Predictor, not a new track score.</p></>}</div><button className="button primary" disabled={!selectedCount || running || submitting || !deviceIds.includes("org.dgw.builtin.variant-consequences")} onClick={() => { void start(); }}>{running || submitting ? <LoaderCircle size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{submitting ? "Submitting…" : running ? currentOnly ? "Creating report…" : "Comparing consequences…" : currentOnly ? page ? "Rebuild report" : "Create report" : "Compare consequences"}</button></div>
    {!currentOnly && <p className="prediction-coverage">{selection.kind === "allTrack" ? "All-track selection" : selection.kind === "interval" ? "Selected interval" : "Explicit selection"} · results group all alleles at each selected locus.</p>}
    {!currentOnly && <button className="dgw-change-selection" title="Return to Track view to select variants" onClick={onBack}><MousePointer2 size={14} aria-hidden="true" />Change selection</button>}
    {!selectedCount && <p className="prediction-empty">Select positions on the track first. Selecting all variants includes every chromosome.</p>}
    {job && (!currentOnly || running || job.status !== "completed") && <div className={`prediction-job-status${running ? " is-running" : ""}`}>
      <div className="prediction-job-stage" role="status">
        {running && <LoaderCircle size={14} aria-hidden="true" />}
        <span title={job.message}>{cancelling && running ? "Cancellation requested · waiting for the current stage" : job.message}</span>
      </div>
      {running && <div className="prediction-job-progress"><progress aria-label={currentOnly ? "Prediction progress" : "Prediction comparison progress"} max={100} value={job.progress} /><span>{job.progress}%</span></div>}
      {running && <button className="prediction-job-cancel" aria-label={currentOnly ? "Cancel prediction" : "Cancel comparison"} title="Cancel after the current compute stage" disabled={cancelling} onClick={() => { setCancelling(true); void api.cancelBackgroundJob(projectPath, job.id).then(next => setJob(next as BackgroundJob<PredictionComparisonReport>)).catch(err => { setCancelling(false); setError(String(err)); }); }}><Square size={12} aria-hidden="true" />{cancelling ? "Cancelling…" : "Cancel"}</button>}
    </div>}
    {!deviceIds.includes("org.dgw.builtin.variant-consequences") && <p>Enable Consequence Predictor in the rack to run this comparison.</p>}
    {error && <p role="alert">{error}</p>}
    {error && job?.status === "completed" && <button onClick={() => { setError(""); setRetry(value => value + 1); }}>Retry loading results</button>}
    {job?.error && <p role="alert">{job.error}</p>}
    {page?.stale && <p role="alert">Results are outdated: track or evidence inputs changed. Run comparison again.</p>}
    {job?.status === "completed" && !page && !error && <p role="status">Loading comparison results…</p>}
    {page && !page.stale && <>
      {!currentOnly && <PredictionOutcomeSummary counts={job?.result?.counts} unit="loci" filter={filter} onFilter={value => { setFilter(value); setOffset(0); }} />}
      <div className={currentOnly ? "prediction-table-toolbar" : undefined}>
      <div className="comparison-actions"><label>Show <select aria-label="Prediction result filter" value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}><option value="">All results</option>{Object.entries(resultLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      {currentOnly && <>
        <div className="prediction-filter-chips" role="group" aria-label="Consequence filter"><span>Consequence</span><button aria-pressed={!consequence.length} onClick={() => { setConsequence([]); setOffset(0); }}>All</button>{(page.consequences ?? []).map(term => <button key={term} aria-pressed={consequence.includes(term)} onClick={() => { setConsequence(values => values.includes(term) ? values.filter(v => v !== term) : [...values, term]); setOffset(0); }}>{term.replace(/_/g, " ")}</button>)}</div>
        <div className="prediction-filter-chips" role="group" aria-label="Impact filter"><span>Impact</span><button aria-pressed={!impact.length} onClick={() => { setImpact([]); setOffset(0); }}>All</button>{["HIGH", "MODERATE", "LOW", "MODIFIER"].filter(term => page.impacts?.includes(term)).map(term => <button key={term} data-impact={term.toLowerCase()} aria-pressed={impact.includes(term)} onClick={() => { setImpact(values => values.includes(term) ? values.filter(v => v !== term) : [...values, term]); setOffset(0); }}>{term}</button>)}</div>
        {(consequence.length > 0 || impact.length > 0 || filter) && <button onClick={() => { setConsequence([]); setImpact([]); setFilter(""); setOffset(0); }}>Clear filters</button>}
      </>}
      </div>
      <ResultPagination total={page.total} offset={offset} onPage={setOffset} position="top" />
      </div>
      {currentOnly ? <div className="comparison-table-scroll prediction-results-scroll"><table className="prediction-results-table"><thead><tr><th>Position · 1-based</th><th>REF → ALT</th><th>Gene</th><th>Predicted consequence</th><th>Impact classes</th><th>Transcripts</th></tr></thead><tbody>{page.rows.map(row => {
        const records = Object.values(row.evidence).flatMap(e => e.records);
        const values = (field: string) => records.flatMap(r => (r[field] ?? "").split("&")).filter(Boolean);
        const transcriptCount = new Set(records.map(r => r.featureId).filter(Boolean)).size;
        return <Fragment key={`${row.locus.contig}:${row.locus.position}:${row.locus.reference}`}><tr className={selected === row ? "is-inspected" : ""}><td className="prediction-position"><span>{row.locus.contig}</span><b>{row.locus.position.toLocaleString()}</b></td><td><div className="prediction-alleles"><code title={row.locus.reference}>{row.locus.reference}</code><span aria-hidden="true">→</span><code title={row.locus.current.map(v => v.key.alternate).join(" / ")}>{row.locus.current.map(v => v.key.alternate).join(" / ") || "REF"}</code></div></td><td><PredictionTerms kind="gene" values={values("geneName")} /></td><td>{records.length ? <PredictionTerms kind="effect" values={values("effect")} /> : <span className="prediction-unknown">{resultLabels[row.outcome]}</span>}</td><td><PredictionTerms kind="impact" values={values("impact")} /></td><td><button className="prediction-inspect" aria-label="Transcripts" aria-expanded={selected === row} onClick={() => setSelected(selected === row ? undefined : row)}>{transcriptCount || "Details"}{selected === row ? <ChevronRight size={14} style={{ transform: "rotate(90deg)" }} /> : <ChevronRight size={14} />}</button></td></tr>
          {selected === row && <tr className="prediction-evidence-row"><td colSpan={6}>{row.locus.current.map(v => <section key={evidenceKey(v.key)}><h3>{v.key.reference} → {v.key.alternate}</h3>{row.evidence[evidenceKey(v.key)] ? <EvidenceCard evidence={row.evidence[evidenceKey(v.key)]} /> : <p>Prediction unavailable</p>}</section>)}{!row.locus.current.length && <p>No current ALT to predict at this locus. This is not a benign classification.</p>}</td></tr>}
        </Fragment>;
      })}</tbody></table></div> : <div className="comparison-table-scroll"><table><thead><tr><th>Locus</th><th>Source ALTs</th><th>Current ALTs</th><th>Result</th><th>Inspect</th></tr></thead><tbody>{page.rows.map(row => <Fragment key={`${row.locus.contig}:${row.locus.position}:${row.locus.reference}`}><tr>
        <td>{row.locus.contig}:{row.locus.position.toLocaleString()}</td><td>{row.locus.source.map(v => v.key.alternate).join(" / ")}</td><td>{row.locus.current.map(v => v.key.alternate).join(" / ") || "No ALT"}</td><td>{labels[row.outcome]}</td><td><button aria-expanded={selected === row} onClick={() => setSelected(selected === row ? undefined : row)}>Evidence</button> <button onClick={() => onFocus(row.locus)}>Go to locus</button></td>
      </tr>{selected === row && <tr className="prediction-evidence-row"><td colSpan={5}>
        <div className="comparison-actions"><b>Evidence · {row.locus.contig}:{row.locus.position.toLocaleString()}</b><button onClick={() => setSelected(undefined)}>Close evidence</button></div>
        <div className="prediction-evidence-pair">{(["source", "current"] as const).map(side => <section key={side} aria-label={`${side} prediction evidence`}><h3>{side === "source" ? "Source" : "Current"} · saved prediction</h3>{row.locus[side].map(variant => <div key={evidenceKey(variant.key)}><h4>{variant.key.reference} → {variant.key.alternate}</h4>{row.evidence[evidenceKey(variant.key)] ? <EvidenceCard evidence={row.evidence[evidenceKey(variant.key)]} /> : <p>Missing evidence</p>}</div>)}{row.locus[side].length === 0 && <p>No ALT to score. This is not a benign classification.</p>}</section>)}</div>
      </td></tr>}</Fragment>)}</tbody></table></div>}
      {page.total > PAGE_SIZE && <ResultPagination total={page.total} offset={offset} onPage={setOffset} position="bottom" />}
      {page.rows.length === 0 && <p>{!filter ? currentOnly ? "No imported loci match this selection." : "No changed loci in the selected positions. Selection alone does not edit the track." : "No loci match this result filter."}</p>}
    </>}
    {currentOnly ? <p className="muted">Selected positions include every current ALT at that locus. Transcript effects are predicted independently, not jointly across variants. Missing predictions are not benign results. Track Monitor uses the strongest transcript impact; inspecting a transcript here does not change its score.</p> : <details className="comparison-details"><summary>What is being compared?</summary><p className="muted">Applied edits at selected loci, including unconsolidated blocks and layers; not unapplied proposals. Each selected locus includes its Source and Current alleles, so multiallelic genotype changes remain together. Excluding a locus excludes its alleles from this comparison. Consequence Predictor compares transcript predictions independently. Results are saved with the job and its selection, not added to the Track Monitor score. Same predictions do not prove equal function. REF reductions remain separate. Missing evidence is not an unchanged prediction.</p></details>}
  </section>;
}
