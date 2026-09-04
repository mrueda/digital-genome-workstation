import type { TransportTarget, TransportTargetKind } from "./types";

export type TransportState = "idle" | "playing" | "paused";

export function GenomeTransportBar({
  contig,
  start,
  end,
  target,
  targetKind,
  state,
  loop,
  scopeLabel,
  evidenceDeviceLabel,
  evidenceRunning,
  disabled,
  onTargetKindChange,
  onPrevious,
  onPlayPause,
  onStop,
  onNext,
  onLoopChange,
  onGo
}: {
  contig: string;
  start: number;
  end: number;
  target?: TransportTarget;
  targetKind: TransportTargetKind;
  state: TransportState;
  loop: boolean;
  scopeLabel: string;
  evidenceDeviceLabel: string;
  evidenceRunning: boolean;
  disabled?: boolean;
  onTargetKindChange: (kind: TransportTargetKind) => void;
  onPrevious: () => void;
  onPlayPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onLoopChange: (enabled: boolean) => void;
  onGo: (contig: string, start: number, end: number) => void;
}) {
  return <section className="genome-transport" aria-label="Genome transport" data-context-help="transport">
    <div className="transport-scope">
      <span>Review</span>
      <select data-context-help="transport-scope" value={targetKind} disabled={disabled || state === "playing"} onChange={(event) => onTargetKindChange(event.target.value as TransportTargetKind)}>
        <option value="variants">Variants</option>
        <option value="activeEdits">Active edits</option>
      </select>
      <small title={scopeLabel}>{scopeLabel}</small>
    </div>
    <div className="transport-controls">
      <button type="button" data-context-help="transport-step" title="Previous ([)" aria-label="Previous review target" disabled={disabled} onClick={onPrevious}>◀</button>
      <button
        type="button"
        data-context-help="transport-play"
        className={state === "playing" ? "active play" : "play"}
        title={state === "playing" ? "Pause automatic review (Space)" : "Automatically review variants and Evidence (Space)"}
        aria-label={state === "playing" ? "Pause automatic review" : "Start automatic variant and Evidence review"}
        disabled={disabled}
        onClick={onPlayPause}
      >{state === "playing" ? "Ⅱ" : "▶"}</button>
      <button type="button" data-context-help="transport-stop" title="Stop and return (Shift+Space)" aria-label="Stop and return to review start" disabled={disabled || state === "idle"} onClick={onStop}>■</button>
      <button type="button" data-context-help="transport-step" title="Next (])" aria-label="Next review target" disabled={disabled} onClick={onNext}>▶</button>
      <button type="button" data-context-help="transport-loop" className={loop ? "active loop" : "loop"} title="Loop review scope (L)" aria-pressed={loop} disabled={disabled} onClick={() => onLoopChange(!loop)}>↻</button>
    </div>
    <div className="transport-position">
      <b>{target ? `${target.sourceKey.contig}:${target.sourceKey.position.toLocaleString()}` : `${contig}:${start.toLocaleString()}–${end.toLocaleString()}`}</b>
      <span title={target ? evidenceDeviceLabel : undefined}>{target
        ? `${targetKind === "variants" ? "variant" : "edit"} ${target.ordinal.toLocaleString()} / ${target.total.toLocaleString()} · ${target.locusStatus === "reference" ? "REF" : "ALT"} · ${evidenceRunning ? "evaluating" : state === "playing" ? "reviewing" : state === "paused" ? "paused" : "ready"}${evidenceDeviceLabel ? `: ${evidenceDeviceLabel}` : ": no active Evidence devices"}`
        : "VCF positions · 1-based"}</span>
    </div>
    <details className="transport-location" data-context-help="coordinate-jump">
      <summary title="Go to coordinates">⌖</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onGo(String(data.get("contig") ?? contig), Number(data.get("start") ?? start), Number(data.get("end") ?? end));
        event.currentTarget.parentElement?.removeAttribute("open");
      }}>
        <label>Chromosome<input name="contig" defaultValue={contig} /></label>
        <label>Start<input name="start" type="number" min="1" defaultValue={start} /></label>
        <label>End<input name="end" type="number" min="1" defaultValue={end} /></label>
        <button type="submit">Go</button>
      </form>
    </details>
  </section>;
}
