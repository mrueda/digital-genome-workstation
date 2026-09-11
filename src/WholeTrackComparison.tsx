import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { EffectiveVariant, TrackComparisonLocus, TrackComparisonPage } from "./types";

function alleles(variants: EffectiveVariant[]) {
  return variants.map(v => `${v.key.alternate} [${v.unphasedAlt ? `unphased${v.unphasedSlot ? ` slot ${v.unphasedSlot}` : ""}` : [v.haplotype1Alt && "A", v.haplotype2Alt && "B"].filter(Boolean).join(" + ")}]`).join("; ") || "No ALT at this locus";
}

export function WholeTrackComparison({ projectPath, trackId, trackName, revision, onBack, onFocus }: {
  projectPath: string; trackId: string; trackName: string; revision: string;
  onBack: () => void; onFocus: (row: TrackComparisonLocus) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [changedOnly, setChangedOnly] = useState(false);
  const pageRevision = useRef<string | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{ key: string; page?: TrackComparisonPage; error?: string }>();
  const key = `${projectPath}:${trackId}:${revision}:${offset}:${attempt}`;
  useEffect(() => { setOffset(0); pageRevision.current = undefined; setNotice(""); }, [projectPath, trackId, revision]);
  useEffect(() => {
    let cancelled = false;
    void api.trackComparisonPage(projectPath, trackId, offset).then(page => {
      if (cancelled) return;
      if (offset > 0 && pageRevision.current && pageRevision.current !== page.revision) {
        pageRevision.current = page.revision; setOffset(0); setNotice("Track changed. Returned to the first page."); return;
      }
      pageRevision.current = page.revision;
      setResult({ key, page });
    }).catch(error => { if (!cancelled) setResult({ key, error: String(error) }); });
    return () => { cancelled = true; };
  }, [key]);
  const ready = result?.key === key ? result : undefined;
  const page = ready?.page;
  const rows = page?.rows.filter(row => !changedOnly || row.changed) ?? [];
  return <section className="comparison-workspace" aria-label="Whole track DNA comparison">
    <header><div><h2>Source → {trackName}</h2><p>DNA comparison across all imported loci</p></div><button className="button secondary" onClick={onBack}>Back to tracks</button></header>
    <p className="muted">Reconstructed alleles and genotype placement, not edit-history counts. Missing ALT means no ALT at that imported locus in the current state—not evidence of a benign effect. Unphased slots are not parental chromosome assignments.</p>
    <div className="comparison-actions">
      <button onClick={() => setOffset(Math.max(0, offset - 200))} disabled={!ready || offset === 0}>Previous page</button>
      <button onClick={() => setOffset(offset + 200)} disabled={!page?.hasMore}>Next page</button>
      {page && <span>{page.totalLoci === 0 ? "0 loci" : `${page.offset + 1}–${Math.min(page.offset + page.limit, page.totalLoci)} of ${page.totalLoci.toLocaleString()} loci`} · {page.rows.filter(row => row.changed).length} changed on this page</span>}
      <label><input type="checkbox" checked={changedOnly} onChange={event => setChangedOnly(event.target.checked)} /> Changed loci on this page</label>
    </div>
    {!ready && <p role="status">Loading comparison page…</p>}
    {notice && <p role="status">{notice}</p>}
    {ready?.error && <p role="alert">{ready.error} <button onClick={() => setAttempt(attempt + 1)}>Retry comparison</button></p>}
    {page && <div className="comparison-table-scroll"><table><thead><tr><th>Locus · REF</th><th>Source alleles</th><th>Current alleles</th><th>DNA</th><th>Inspect</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.contig}:${row.position}:${row.reference}`}>
        <td>{row.contig}:{row.position.toLocaleString()} · {row.reference}</td><td>{alleles(row.source)}</td><td>{alleles(row.current)}</td>
        <td>{row.changed ? "Changed" : "Unchanged"}</td><td><button onClick={() => onFocus(row)} aria-label={`Focus locus ${row.contig}:${row.position}`}>Focus region</button></td>
      </tr>)}</tbody></table></div>}
    {page && rows.length === 0 && <p>No matching loci on this page.</p>}
    <p className="muted">Pages group all imported ALTs at one coordinate and REF together. Use Focus region for allele-level evidence and editing. Prediction comparisons remain region-scoped; this view makes no whole-track prediction claim.</p>
  </section>;
}
