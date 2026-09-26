import { useLayoutEffect, useRef } from "react";
import { EvidenceCard } from "./EvidenceCard";
import type { EvidenceResult } from "./types";

/** Keep each device's footprint during loading without showing another allele's results. */
export function EvidenceSlot({ evidence, deviceId, title, alleleKey, loading }: {
  evidence?: EvidenceResult; deviceId: string; title: string; alleleKey: string; loading: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const height = useRef(160);
  useLayoutEffect(() => {
    if (!evidence || !container.current) return;
    const observer = new ResizeObserver(() => {
      if (container.current) height.current = container.current.getBoundingClientRect().height;
    });
    height.current = container.current.getBoundingClientRect().height;
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [evidence]);
  return <div ref={container} className="evidence-slot" aria-busy={loading && !evidence}>
    {evidence ? <EvidenceCard key={alleleKey} evidence={evidence} deviceId={deviceId} />
      : <article className="evidence-card evidence-loading" style={{ minHeight: height.current }} aria-label={`${title} loading`}>
        <header><h4>{title}</h4><span className="status">{loading ? "Loading…" : "Not evaluated"}</span></header>
        <div className="evidence-loading-lines" aria-hidden="true"><span /><span /><span /></div>
      </article>}
  </div>;
}
