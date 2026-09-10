import { useState } from "react";
import type { EvidenceResult } from "./types";

const labels: Record<string, string> = {
 effect: "Consequence", impact: "Impact", geneName: "Gene", featureId: "Transcript",
 transcriptBiotype: "Transcript type", dnaChange: "DNA change", aminoAcidChange: "Protein change",
 annotationRelease: "Annotation release", engineVersion: "Engine version",
 CLNSIG: "Clinical significance", CLNREVSTAT: "Review status"
};

export function EvidenceCard({ evidence }: { evidence: EvidenceResult }) {
  const [recordIndex, setRecordIndex] = useState(0);
  const index = Math.min(recordIndex, Math.max(0, evidence.records.length - 1));
  const record = evidence.records[index];
  const transcripts = evidence.source.startsWith("Variant Consequences");
  const effects = [...new Set(evidence.records.map(row => row.effect).filter(Boolean))];
  return <article className="evidence-card" aria-label={`${evidence.source} evidence`}>
    <header><h4>{evidence.source}</h4><span className={`status ${evidence.status}`}>{evidence.status.replace(/[A-Z]/g, value => ` ${value.toLowerCase()}`)}</span></header>
    {evidence.message && <p className="warning">{evidence.message}</p>}
    {effects.length > 0 && <p className="evidence-summary">{effects.join(" · ")}</p>}
    {evidence.records.length > 1 && <label className="evidence-record-selector">
      {transcripts ? "Transcript consequences" : "Matched records"} · {index + 1} / {evidence.records.length}
      <select aria-label={`${evidence.source} record`} value={index} onChange={event => setRecordIndex(Number(event.target.value))}>
        {evidence.records.map((row, i) => <option key={i} value={i}>
          {i + 1}. {row.featureId ?? row.transcript ?? row.id ?? "Record"}{row.impact ? ` · ${row.impact}` : ""}{row.effect ? ` · ${row.effect}` : ""}
        </option>)}
      </select>
    </label>}
    {record && <dl>{Object.entries(record).filter(([key, value]) => key !== "raw" && value)
      .map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{value}</dd></div>)}</dl>}
    {record?.raw && <details><summary>Raw matched record</summary><code className="raw-record">{record.raw}</code></details>}
    {evidence.status === "noExactMatch" && <p className="muted">No exact normalized allele was found. This is not evidence of benignity.</p>}
  </article>;
}
