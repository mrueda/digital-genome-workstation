import { useEffect, useState } from "react";
import type { EvidenceResult, VariantKey } from "./types";
import { selectionEvidenceKey } from "./selectedAlleleEvidence";
import { evidencePresentation } from "./evidencePresentation";
import { PredictionTerms } from "./PredictionTerms";
import { EvidenceFieldValue } from "./EvidenceFieldValue";
import { evidenceProvider } from "./evidenceFields";

type Evidence = Record<string, EvidenceResult>;
function summary(result?: EvidenceResult, deviceId?: string) {
  if (!result) return "Not evaluated";
  if (result.status !== "found") return result.status === "noExactMatch" ? "No exact match (unknown)" : evidencePresentation(result, deviceId).message || result.status;
  const values = (field: string) => result.records.map(row => row[field]).filter(Boolean);
  if (!values("impact").length && !values("effect").length && !values("CLNSIG").length) return "Matched records available";
  return <div className="evidence-comparison-labels">
    {values("impact").length > 0 && <PredictionTerms kind="impact" values={values("impact")} />}
    {values("effect").length > 0 && <PredictionTerms kind="effect" values={values("effect")} />}
    {[...new Set(values("CLNSIG"))].map(value => <EvidenceFieldValue key={value} provider={evidenceProvider(result.source, deviceId)} field="CLNSIG" value={value} />)}
  </div>;
}

export function AlleleEvidenceComparison({ source, current, restored, deviceIds, revision, load }: {
  source?: VariantKey; current?: VariantKey; restored: boolean; deviceIds: string[]; revision: string;
  load: (key: VariantKey, ids: string[], cached: boolean) => Promise<Evidence>;
}) {
  const signature = JSON.stringify([source && selectionEvidenceKey(source), current && selectionEvidenceKey(current), restored, deviceIds, revision]);
  const [result, setResult] = useState<{ signature: string; source: Evidence; current: Evidence; error?: string }>();
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      source ? load(source, deviceIds, true) : Promise.resolve({}),
      current && !restored ? load(current, deviceIds, true) : Promise.resolve({})
    ]).then(([before, after]) => {
      if (!cancelled) setResult({ signature, source: before, current: after });
    }).catch(() => { if (!cancelled) setResult({ signature, source: {}, current: {}, error: "Comparison unavailable. Refresh Evidence to retry." }); });
    return () => { cancelled = true; };
  }, [signature]);
  const ready = result?.signature === signature ? result : undefined;
  return <section className="allele-evidence-comparison" aria-label="Source and current evidence">
    <h4>Source → Current</h4>
    <p className="muted">Source is the imported individual's ALT, not the reference genome. Each allele is evaluated independently.</p>
    <table>
      <thead><tr><th>Evidence</th><th>Source ALT <code>{source?.alternate ?? "Unknown"}</code></th><th>Current <code>{restored ? source?.reference ?? "REF" : current?.alternate ?? "Unavailable"}</code></th></tr></thead>
      <tbody>{deviceIds.map(id => <tr key={id}>
        <th>{ready?.source[id] || ready?.current[id] ? evidencePresentation(ready.source[id] ?? ready.current[id], id).title : id.split(".").at(-1)}</th>
        <td>{!source ? "Source allele unresolved" : !ready ? "Loading…" : summary(ready.source[id], id)}</td>
        <td>{restored ? "REF restored · not scored as an ALT" : !current ? "No active ALT selected" : !ready ? "Loading…" : summary(ready.current[id], id)}</td>
      </tr>)}</tbody>
    </table>
    {deviceIds.length === 0 && <p className="muted">No active Evidence devices.</p>}
    {ready?.error && <p role="status">{ready.error}</p>}
  </section>;
}
