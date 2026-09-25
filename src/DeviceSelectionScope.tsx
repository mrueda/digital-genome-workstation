import { MousePointer2 } from "lucide-react";

/** Shared selection strip for expanded devices, including Track Compare. */
export function DeviceSelectionScope({ track, count, scope, onChange, label = "Device input scope" }: {
  track: string; count: number; scope: string; onChange: () => void; label?: string;
}) {
  return <div className="dgw-device-scope" aria-label={label}>
    <span className="dgw-device-scope-track">Track: <b>{track}</b></span>
    <div role="status"><strong>{count ? `${count.toLocaleString()} ${count === 1 ? "allele" : "alleles"} selected` : "No alleles selected"}</strong><span>{scope}</span></div>
    <button className="dgw-change-selection" type="button" title="Return to Track view to select variants" onClick={onChange}><MousePointer2 size={14} aria-hidden="true" />Change selection</button>
  </div>;
}
