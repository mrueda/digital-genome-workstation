import { useState } from "react";
import type { EvidenceResult } from "./types";
import { evidencePresentation } from "./evidencePresentation";
import { EvidenceFieldValue } from "./EvidenceFieldValue";
import { evidenceProvider, evidenceFieldLabel, evidenceFieldOrder, isPrimaryEvidenceField } from "./evidenceFields";

export function EvidenceCard({ evidence, deviceId }: { evidence: EvidenceResult; deviceId?: string }) {
  const display = evidencePresentation(evidence, deviceId);
  const [recordIndex, setRecordIndex] = useState(0);
  const index = Math.min(recordIndex, Math.max(0, evidence.records.length - 1));
  const record = evidence.records[index];
  const provider = evidenceProvider(evidence.source, deviceId);
  const transcripts = provider === "prediction";
  const fields = record ? Object.entries(record).filter(([key, value]) => key !== "raw" && value) : [];
  const primary = fields.filter(([key]) => isPrimaryEvidenceField(provider, key))
    .sort(([a], [b]) => evidenceFieldOrder(provider, a) - evidenceFieldOrder(provider, b));
  const additional = fields.filter(([key]) => !isPrimaryEvidenceField(provider, key));
  const renderField = ([key, value]: [string, string]) => <div key={key}><dt>{evidenceFieldLabel(provider, key)}</dt><dd><EvidenceFieldValue provider={provider} field={key} value={value} /></dd></div>;
  return <article className="evidence-card" aria-label={`${display.title} ${transcripts ? "predictions" : "evidence"}`}>
    <header><h4>{display.title}</h4><span className={`status ${evidence.status}`}>{transcripts && evidence.status === "found" ? "Predicted" : evidence.status === "resourceUnavailable" ? "Unavailable" : evidence.status.replace(/[A-Z]/g, value => ` ${value.toLowerCase()}`)}</span></header>
    <p className="muted">{transcripts ? "Computed transcript effects · bcftools csq. Predictions, not experimental confirmation." : provider === "clinvar" ? "ClinVar · submitted classifications. Conditions are reported for the record, not paired with individual classification labels." : provider === "cosmic" ? "COSMIC · reported somatic variant records. A match alone does not establish causality." : "Database records"}</p>
    {display.message && <p className="warning">{display.message}</p>}
    {display.explanation && <p className="muted">{display.explanation}</p>}
    {evidence.records.length > 1 && <label className="evidence-record-selector">
      {transcripts ? "Transcript consequences" : "Matched records"} · {index + 1} / {evidence.records.length}
      <select aria-label={`${evidence.source} record`} value={index} onChange={event => setRecordIndex(Number(event.target.value))}>
        {evidence.records.map((row, i) => <option key={i} value={i}>
          {i + 1}. {row.featureId ?? row.transcript ?? row.id ?? "Record"}{row.impact ? ` · ${row.impact}` : ""}{row.effect ? ` · ${row.effect}` : ""}
        </option>)}
      </select>
    </label>}
    {primary.length > 0 && <dl>{primary.map(renderField)}</dl>}
    {additional.length > 0 && <details><summary>{transcripts ? "Resource details" : "Additional annotations"} · {additional.length}</summary><dl>{additional.map(renderField)}</dl></details>}
    {record?.raw && <details><summary>Raw matched record</summary><code className="raw-record">{record.raw}</code></details>}
    {evidence.status === "noExactMatch" && <p className="muted">No exact normalized allele was found. This is not evidence of benignity.</p>}
  </article>;
}
