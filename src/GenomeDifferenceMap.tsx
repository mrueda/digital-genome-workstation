import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { LocusEvidenceComparison } from "./LocusEvidenceComparison";
import type { EvidenceResult, FocusContext, GeneSearchHit, TrackComparisonLocus, TrackComparisonMap, VariantKey, VariantSelection } from "./types";

const changeLabels = { sequence: "ALT sequence changed", altCopies: "ALT copies added / removed", placement: "Copy / phase changed" };
const changeKinds = ["sequence", "altCopies", "placement"] as const;

export function GenomeDifferenceMap({ projectPath, trackId, revision, region, deviceIds, load, onFocus, selection }: {
  selection: VariantSelection;
  projectPath: string; trackId: string; revision: string; region: FocusContext;
  deviceIds: string[]; load: (key: VariantKey, ids: string[], cached: boolean) => Promise<Record<string, EvidenceResult>>;
  onFocus: (locus: TrackComparisonLocus) => void;
}) {
  const [scope, setScope] = useState<FocusContext>();
  const [history, setHistory] = useState<Array<FocusContext | undefined>>([]);
  const [result, setResult] = useState<{ key: string; data: TrackComparisonMap }>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [bins, setBins] = useState(128);
  const [selected, setSelected] = useState<TrackComparisonLocus>();
  const [query, setQuery] = useState("");
  const [genes, setGenes] = useState<GeneSearchHit[]>([]);
  const [searchStatus, setSearchStatus] = useState("");
  const searchRequest = useRef(0);
  const [drag, setDrag] = useState<{ contig: string; from: number; to: number }>();
  const host = useRef<HTMLDivElement>(null);
  const evidence = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, TrackComparisonMap>());
  const key = JSON.stringify([projectPath, trackId, revision, selection, scope, bins, retry]);
  const data = result?.key === key ? result.data : undefined;
  useEffect(() => {
    const observer = new ResizeObserver(entries => setBins(Math.max(16, Math.min(512, Math.floor(entries[0].contentRect.width / 6)))));
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setSelected(undefined); setError("");
    const saved = cache.current.get(key);
    if (saved) { setResult({ key, data: saved }); return; }
    void api.trackComparisonMap(projectPath, trackId, selection, scope, bins).then(data => {
      if (cancelled) return;
      cache.current.set(key, data);
      if (cache.current.size > 12) cache.current.delete(cache.current.keys().next().value!);
      setResult({ key, data });
    }).catch(err => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [key]);
  useEffect(() => { evidence.current?.scrollIntoView({ block: "nearest", behavior: "instant" }); }, [selected]);
  function navigate(next?: FocusContext) {
    setHistory(current => [...current.slice(-39), scope]); setScope(next);
  }
  function zoom(factor: number) {
    if (!scope) return;
    const middle = (scope.start + scope.end) / 2;
    const span = Math.max(1, Math.round((scope.end - scope.start + 1) * factor));
    const start = Math.max(1, Math.floor(middle - span / 2));
    navigate({ ...scope, start, end: start + span - 1 });
  }
  function fullChromosome(contig: string) {
    setError("");
    void api.trackComparisonMap(projectPath, trackId, selection, undefined, 1).then(overview => {
      const extent = overview.strips.find(item => item.contig.replace(/^chr/, "") === contig.replace(/^chr/, ""));
      if (extent) navigate({ contig: extent.contig, start: extent.start, end: extent.end });
      else setError("No imported loci on this chromosome.");
    }).catch(err => setError(String(err)));
  }
  const counts = data?.strips.reduce((sum, strip) => {
    for (const bin of strip.bins) { sum.total += bin.total; sum.changed += bin.changed; }
    return sum;
  }, { total: 0, changed: 0 });
  return <section className="comparison-workspace genome-difference-map" aria-label="Genome difference map">
    <div className="comparison-actions">
      <button disabled={!history.length} onClick={() => { setScope(history[history.length - 1]); setHistory(history.slice(0, -1)); }}>Back</button>
      <button disabled={!scope} onClick={() => navigate()}>Whole genome</button>
      <button disabled={!scope} onClick={() => { if (scope) fullChromosome(scope.contig); }}>Full chromosome</button>
      <button onClick={() => navigate(region)}>Fit working region</button>
      <button disabled={!scope} onClick={() => zoom(0.5)}>Zoom in</button>
      <button disabled={!scope} onClick={() => zoom(2)}>Zoom out</button>
    </div>
    <form className="comparison-dna-search" onSubmit={async event => {
      event.preventDefault(); const request = ++searchRequest.current;
      setGenes([]); setSearchStatus("Searching genes…");
      try {
        const hits = await api.searchGenes(projectPath, query.trim());
        if (request === searchRequest.current) { setGenes(hits); setSearchStatus(hits.length ? "" : "No matching genes."); }
      } catch (err) { if (request === searchRequest.current) setSearchStatus(String(err)); }
    }}>
      <label htmlFor="map-gene-search">Find gene</label>
      <input id="map-gene-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. TTN" />
      <button disabled={!query.trim()}>Search</button>
    </form>
    {searchStatus && <p role="status">{searchStatus}</p>}
    {genes.length > 0 && <div className="comparison-actions">{genes.map(gene => <button key={gene.geneId} onClick={() => { navigate({ contig: gene.contig, start: gene.start, end: gene.end }); setGenes([]); }}>{gene.symbol} · {gene.contig}:{gene.start.toLocaleString()}–{gene.end.toLocaleString()}</button>)}</div>}
    <div className="genome-map-heading"><b>{scope ? `${scope.contig}:${scope.start.toLocaleString()}–${scope.end.toLocaleString()}` : "All chromosomes · imported-locus extents"}</b>
      {counts && <span>{counts.changed.toLocaleString()} / {counts.total.toLocaleString()} loci differ</span>}
    </div>
    <div className="genome-map-legend"><span><i className="is-empty" /> No selected loci</span><span><i className="is-same" /> Same genotype</span>{changeKinds.map(kind => <span key={kind}><i className={`change-${kind}`} /> {changeLabels[kind]}</span>)}</div>
    <p className="muted">Bar height: % of selected loci changed in each interval · fixed 0–100% scale. Colour shows the type of change.</p>
    <div ref={host} aria-busy={!data && !error}>
      {!data && !error && <p role="status">Building difference map… Resolving effective genotypes, including bulk layers.</p>}
      {error && <p role="alert">{error} <button onClick={() => setRetry(retry + 1)}>Retry</button></p>}
      {data?.strips.map(strip => <div className="genome-map-strip" key={strip.contig}>
        <button title="Fit imported chromosome extent" onClick={() => fullChromosome(strip.contig)}>{strip.contig}</button>
        <div>
          <div className="genome-map-plot"><span className="genome-map-y-axis"><span>100%</span><span>0%</span></span>
          <svg viewBox="0 0 1000 76" preserveAspectRatio="none" aria-label={`Chromosome ${strip.contig} differences`}
            onPointerDown={event => {
              if (event.button !== 0) return;
              const box = event.currentTarget.getBoundingClientRect();
              const x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
              setDrag({ contig: strip.contig, from: x, to: x }); event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              if (!drag || drag.contig !== strip.contig) return;
              const box = event.currentTarget.getBoundingClientRect();
              setDrag({ ...drag, to: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) });
            }}
            onPointerCancel={() => setDrag(undefined)}
            onPointerUp={event => {
              if (!drag) return;
              const box = event.currentTarget.getBoundingClientRect();
              const to = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
              const span = strip.end - strip.start + 1;
              if (Math.abs(to - drag.from) * box.width > 5) {
                navigate({ contig: strip.contig, start: strip.start + Math.floor(Math.min(to, drag.from) * (span - 1)), end: strip.start + Math.floor(Math.max(to, drag.from) * (span - 1)) });
              } else {
                const pos = strip.start + Math.floor(to * (span - 1));
                const bin = strip.bins.find(bin => bin.start <= pos && bin.end >= pos);
                if (bin) navigate({ contig: strip.contig, start: bin.start, end: bin.end });
              }
              setDrag(undefined);
            }}>
            {strip.bins.map(bin => {
              const x = (bin.start - strip.start) / (strip.end - strip.start + 1) * 1000;
              const width = (bin.end - bin.start + 1) / (strip.end - strip.start + 1) * 1000;
              const percent = bin.total ? bin.changed / bin.total * 100 : 0;
              const label = `${strip.contig}:${bin.start.toLocaleString()}–${bin.end.toLocaleString()} · ${bin.changed} of ${bin.total} selected loci changed (${percent.toFixed(1)}%) · ${bin.sequence} ALT sequence · ${bin.altCopies} ALT copies added/removed · ${bin.placement} copy/phase · ${bin.total - bin.changed} same genotype`;
              let used = 0;
              return <g key={bin.start}><rect x={x} y={2} width={width} height={68}
                className={bin.total === 0 ? "is-empty" : "map-imported-background"}
                pointerEvents="none" />
                {changeKinds.map(kind => {
                  const height = bin.total ? bin[kind] / bin.total * 68 : 0;
                  used += height;
                  return height > 0 ? <rect key={kind} x={x} y={70 - used} width={width} height={height} className={`change-${kind}`} pointerEvents="none" /> : null;
                })}
                <rect x={x} y={72} width={Math.max(1, width)} height={3} className={bin.total === 0 ? "is-empty" : bin.changed === 0 ? "is-same" : `change-${changeKinds.reduce((best, kind) => bin[kind] > bin[best] ? kind : best, "sequence")}`} pointerEvents="none" />
                <rect x={x} y={0} width={width} height={76} fill="transparent"
                role="button" tabIndex={0} aria-label={label}
                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate({ contig: strip.contig, start: bin.start, end: bin.end }); } }}><title>{label}</title></rect>
              </g>;
            })}
            {drag?.contig === strip.contig && <rect className="genome-map-brush" x={Math.min(drag.from, drag.to) * 1000} y={0} width={Math.abs(drag.to - drag.from) * 1000} height={76} pointerEvents="none" />}
          </svg>
          </div>
          <div className="genome-map-coordinates"><span>{strip.start.toLocaleString()}</span><span>{strip.end.toLocaleString()} · 1-based</span></div>
        </div>
      </div>)}
    </div>
    {data && !counts?.total && <p>No selected loci in this region. This does not establish reference sequence or matching genomes.</p>}
    {data && counts && counts.total > 0 && !data.rows.length && <p className="muted">Click a bin or drag across a strip to zoom. Individual alleles appear at 80 selected loci or fewer.</p>}
    {!!data?.rows.length && <div className="genome-map-alleles" aria-label="Aligned allele differences">
      {data.rows.map((row, index) => <button key={`${row.contig}:${row.position}:${row.reference}`} className={data.rowTypes[index] ? `allele-change-${data.rowTypes[index]}` : ""} aria-pressed={selected === row} onClick={() => setSelected(row)}>
        <b>{row.contig}:{row.position.toLocaleString()}</b><small>REF {row.reference}</small>
        <small>{data.rowTypes[index] ? changeLabels[data.rowTypes[index]!] : "Same genotype"}</small>
        {(["source", "current"] as const).map(side => <span key={side}><small>{side === "source" ? "Source" : "Current"}</small><strong>{row[side].map(v => `${v.key.alternate} (${v.unphasedAlt ? "unphased" : [v.haplotype1Alt && "A", v.haplotype2Alt && "B"].filter(Boolean).join("+")})`).join(" / ") || "No ALT"}</strong></span>)}
      </button>)}
    </div>}
    {selected && <div ref={evidence}><div className="comparison-actions"><button onClick={() => setSelected(undefined)}>Close evidence</button><button onClick={() => onFocus(selected)}>Go to locus</button></div><LocusEvidenceComparison locus={selected} deviceIds={deviceIds} load={load} /></div>}
    <details className="comparison-details"><summary>How to read the changes</summary><p>Each locus is counted once. A change in the number of ALT copies is amber, including restoration to REF. Otherwise, a change in ALT allele content is cyan. With the same allele content, changed copy assignment or phase is violet. A locus changing in several ways is assigned in that order.</p><p>The thin baseline marks intervals containing changes, even when the bar is too short to see. Its colour is the most common change type. Bar segments show all types. Same-genotype intervals have a grey baseline; empty intervals have none.</p><p>DNA differences, not predicted impact or statistical significance. Counts include active blocks and bulk layers. Empty regions are not evidence of reference calls. Chromosome strips have independent coordinate scales.</p></details>
  </section>;
}
