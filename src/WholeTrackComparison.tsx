import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import type { EffectiveVariant, EvidenceResult, VariantKey, TrackComparisonLocus, TrackComparisonPage, VariantSelection } from "./types";
import { LocusEvidenceComparison } from "./LocusEvidenceComparison";
import { ArrowDown, ChevronLeft, ChevronRight, Dna, List, MousePointer2 } from "lucide-react";

function alleles(variants: EffectiveVariant[]) {
  return variants.map(v => `${v.key.alternate} [${v.unphasedAlt ? `unphased${v.unphasedSlot ? ` slot ${v.unphasedSlot}` : ""}` : [v.haplotype1Alt && "A", v.haplotype2Alt && "B"].filter(Boolean).join(" + ")}]`).join("; ") || "No ALT at this locus";
}

export function WholeTrackComparison({ projectPath, trackId, trackName, revision, onFocus, deviceIds, load, selection }: {
  selection: VariantSelection;
  projectPath: string; trackId: string; trackName: string; revision: string;
  onBack: () => void; onFocus: (row: TrackComparisonLocus) => void;
  deviceIds: string[];
  load: (key: VariantKey, ids: string[], cached: boolean) => Promise<Record<string, EvidenceResult>>;
}) {
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [changedOnly, setChangedOnly] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<TrackComparisonLocus>();
  const evidencePanel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (selected) evidencePanel.current?.scrollIntoView({ block: "start", behavior: "instant" }); }, [selected]);
  const pageRevision = useRef<string | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{ key: string; page?: TrackComparisonPage; error?: string }>();
  const key = `${projectPath}:${trackId}:${revision}:${offset}:${attempt}:${changedOnly}:${search}:${JSON.stringify(selection)}`;
  useEffect(() => { setSelected(undefined); }, [key]);
  useEffect(() => { setOffset(0); pageRevision.current = undefined; setNotice(""); }, [projectPath, trackId, revision]);
  useEffect(() => {
    let cancelled = false;
    void api.trackComparisonPage(projectPath, trackId, selection, offset, 200, changedOnly, search).then(page => {
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
  const rows = page?.rows ?? [];
  const changedRows = rows.filter(row => row.changed);
  const percent = page?.changedLoci != null && page.totalLoci > 0 ? page.changedLoci / page.totalLoci * 100 : undefined;
  return <section className="comparison-workspace comparison-dna" aria-label="Whole track DNA comparison">
    <div className="comparison-dna-overview" aria-label="DNA difference summary">
      <div className="comparison-dna-stat"><Dna aria-hidden="true" /><div><b>{page?.changedLoci == null ? "—" : page.changedLoci.toLocaleString()}</b><span>{page?.changedLoci === 1 ? "differing locus" : "differing loci"}</span></div></div>
      <div className="comparison-dna-stat"><List aria-hidden="true" /><div><b>{page?.totalLoci.toLocaleString() ?? "—"}</b><span>selected loci</span></div></div>
      <div className="comparison-dna-coverage"><span>{percent === undefined ? "Changed-only view gives the total" : `${percent.toFixed(1)}% of selected loci differ`}</span><div className="comparison-dna-bar" aria-hidden="true"><i style={{ width: `${percent ?? 0}%` }} /></div><small>DNA and copy placement · not a predicted-effect score</small></div>
    </div>
    <form className="comparison-dna-search" onSubmit={event => { event.preventDefault(); setOffset(0); setSearch(searchInput.trim()); }}>
      <label htmlFor="comparison-locus-search">Find locus</label>
      <input id="comparison-locus-search" type="search" value={searchInput} placeholder="7 or 7:140453136 or 7:140453000-140454000" aria-describedby="comparison-search-help" onChange={event => setSearchInput(event.target.value)} />
      <button type="submit">Search</button>
      {(search || searchInput) && <button type="button" onClick={() => { setSearchInput(""); setSearch(""); setOffset(0); }}>Clear search</button>}
      <small id="comparison-search-help">Selected results · 1-based coordinates{search ? ` · Filter: ${search}` : ""}</small>
    </form>
    <div className="comparison-actions comparison-dna-toolbar">
      <button aria-label="Previous page" title="Previous page" onClick={() => setOffset(Math.max(0, offset - 200))} disabled={!ready || offset === 0}><ChevronLeft aria-hidden="true" /></button>
      <button aria-label="Next page" title="Next page" onClick={() => setOffset(offset + 200)} disabled={!page?.hasMore}><ChevronRight aria-hidden="true" /></button>
      {page && <span>{page.matchingLoci === 0 ? "0 loci" : `${page.offset + 1}–${Math.min(page.offset + page.limit, page.matchingLoci)} of ${page.matchingLoci.toLocaleString()} loci`}{search ? " matching search" : ""} · {changedOnly ? `${page.changedLoci?.toLocaleString()} changed across ${page.totalLoci.toLocaleString()} selected loci` : `${page.rows.filter(row => row.changed).length} changed on this page`}</span>}
      <label><input type="checkbox" aria-label="Changed loci across track" checked={changedOnly} onChange={event => { setOffset(0); setChangedOnly(event.target.checked); }} /> Differences only</label>
    </div>
    {!ready && <p role="status">{changedOnly ? "Finding changed loci within the selection… The first request builds an index." : "Loading comparison page…"}</p>}
    {notice && <p role="status">{notice}</p>}
    {ready?.error && <p role="alert">{ready.error} <button onClick={() => setAttempt(attempt + 1)}>Retry comparison</button></p>}
    {changedRows.length > 0 && <div className="comparison-change-board" aria-label="Source and current allele matrix">
      <header><h3>Source <ArrowDown aria-hidden="true" /> Current</h3><span><MousePointer2 aria-hidden="true" /> Select a position for evidence</span></header>
      <div className="comparison-change-grid">{changedRows.slice(0, 40).map(row => <button type="button" className="comparison-change-tile" aria-pressed={selected === row} aria-label={`Inspect difference ${row.contig}:${row.position}`} key={`${row.contig}:${row.position}:${row.reference}`} onClick={() => setSelected(row)}>
        <span className="comparison-tile-position">{row.contig}:<b>{row.position.toLocaleString()}</b><small title={`Reference sequence: ${row.reference}`}>REF {row.reference}</small></span>
        {(["source", "current"] as const).map(side => <span className={`comparison-base-lane ${side}`} key={side}><small>{side === "source" ? "Source" : "Current"}</small><span>{row[side].length === 0 ? <b className="comparison-no-alt">No ALT</b> : row[side].map((v, index) => <span className="comparison-base-chip" key={index} title={alleles([v])}><b>{v.key.alternate}</b><small>{v.unphasedAlt ? "unphased" : [v.haplotype1Alt && "A", v.haplotype2Alt && "B"].filter(Boolean).join(" + ")}</small></span>)}</span></span>)}
      </button>)}</div>
      <footer><span>Cyan marks different DNA or copy placement, not predicted impact.</span><span>{Math.min(40, changedRows.length)} of {changedRows.length} differences on this page{changedRows.length > 40 ? " · remaining rows below" : ""}</span></footer>
    </div>}
    {selected && <div ref={evidencePanel} className="comparison-evidence-anchor"><LocusEvidenceComparison key={`${selected.contig}:${selected.position}:${selected.reference}`} locus={selected} deviceIds={deviceIds} load={load} /></div>}
    {page && <details className="comparison-row-details"><summary>All rows on this page · {rows.length}</summary><div className="comparison-table-scroll"><table><thead><tr><th>Locus · REF</th><th>Source alleles</th><th>Current alleles</th><th>DNA</th><th>Inspect</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.contig}:${row.position}:${row.reference}`}>
        <td>{row.contig}:{row.position.toLocaleString()} · {row.reference}</td><td>{alleles(row.source)}</td><td>{alleles(row.current)}</td>
        <td>{row.changed ? "Changed" : "Unchanged"}</td><td><button onClick={() => setSelected(row)} aria-label={`Inspect row ${row.contig}:${row.position}`}>Inspect evidence</button> <button onClick={() => onFocus(row)} aria-label={`Focus locus ${row.contig}:${row.position}`}>{row.current.length === 1 ? "Open allele" : "Focus region"}</button></td>
      </tr>)}</tbody></table></div></details>}
    {page && rows.length === 0 && <p>{search ? "No loci match this search and the current Differences only filter." : changedOnly && page.matchingLoci === 0 ? "The selected loci currently match Source. Selecting variants does not change them: generate mutations or edit an allele, then return here. Applied blocks and layers count immediately; consolidation is not required. Matching DNA is not a biological assessment." : "No matching loci on this page."}</p>}
    <details className="comparison-details"><summary>How to read this</summary><p className="muted">Current track: {trackName}. Each locus is a coordinate and REF, not an edit block. A/B are chromosome-copy labels, not parental assignments; unphased alleles remain unassigned. No ALT means no alternate allele in the effective state at this imported locus, not a benign classification. All views use the selection from Track view. Prediction analysis is separate from these DNA differences.</p></details>
  </section>;
}
