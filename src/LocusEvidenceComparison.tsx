import { useEffect, useState } from "react";
import { EvidenceCard } from "./EvidenceCard";
import type { EvidenceResult, TrackComparisonLocus, VariantKey } from "./types";

export function LocusEvidenceComparison({ locus, deviceIds, load }: {
  locus: TrackComparisonLocus;
  deviceIds: string[];
  load: (key: VariantKey, ids: string[], cached: boolean) => Promise<Record<string, EvidenceResult>>;
}) {
  const [results, setResults] = useState<Record<string, Record<string, EvidenceResult>>>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const keyOf = (key: VariantKey) => JSON.stringify(key);
  const requestKey = JSON.stringify([locus.source.map(v => v.key), locus.current.map(v => v.key), deviceIds]);
  useEffect(() => {
    let cancelled = false;
    setResults({}); setError(""); setPending(true);
    if (deviceIds.length === 0) { setPending(false); return; }
    const unique = new Map([...locus.source, ...locus.current].map(v => [keyOf(v.key), v.key]));
    void Promise.all([...unique].map(async ([id, key]) => [id, await load(key, deviceIds, true)] as const))
      .then(entries => { if (!cancelled) setResults(Object.fromEntries(entries)); })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setPending(false); });
    return () => { cancelled = true; };
  }, [requestKey]);
  return <section className="comparison-locus-evidence" aria-label="Evidence for selected DNA difference">
    <h3>Predicted effect and evidence · {locus.contig}:{locus.position.toLocaleString()}</h3>
    {deviceIds.length === 0 ? <p>No evidence devices are active. The DNA difference above is still valid.</p>
      : <>
      <div className="comparison-evidence-status" role="status">{pending ? "Evaluating source and current alleles…" : error ? "Evidence could not be loaded." : "Evidence loaded."}</div>
      {error && <p role="alert">{error}</p>}
      <div className="prediction-evidence-pair" aria-busy={pending}>{(["source", "current"] as const).map(side => <section key={side}>
        <h4>{side === "source" ? "Source" : "Current"}</h4>
        {locus[side].length === 0 && <p>No ALT at this locus. No ALT prediction is assigned; this is not a benign classification.</p>}
        {locus[side].map(v => <div key={`${keyOf(v.key)}:${v.unphasedSlot ?? ""}`}><h4>{v.key.reference} → {v.key.alternate}</h4>
          {deviceIds.map(id => <div className="comparison-evidence-slot" key={id}>{pending ? <div className="comparison-evidence-placeholder" aria-hidden="true"><span /><span /><span /></div> : results[keyOf(v.key)]?.[id] ? <EvidenceCard evidence={results[keyOf(v.key)][id]} deviceId={id} /> : <p>Not evaluated · {id}</p>}</div>)}
        </div>)}
      </section>)}</div></>}
    <p>DNA differences and predicted effects are separate. Equal impact categories do not establish equal function.</p>
  </section>;
}
