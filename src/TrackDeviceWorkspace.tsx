import { useEffect, useState, type CSSProperties, type ReactNode, type WheelEvent } from "react";
import { focusViewport, panViewport, viewportSpan, zoomViewport } from "./genomeViewport";
import type { FocusContext } from "./types";
import "./track-device.css";

export type GenomeTrackKind = "source" | "candidate";
export type OptimizerDirection = "minimize" | "maximize";
export type OptimizerStatus = "idle" | "ready" | "running" | "stale" | "error";
export type RackDeviceKind = "editing" | "annotation" | "prediction" | "evidence";
export type RackDeviceTarget = "selectedAllele" | "focusedRegion";
export type RackDeviceStatus =
  | OptimizerStatus
  | "complete"
  | "found"
  | "noExactMatch"
  | "notComputed"
  | "resourceUnavailable";

export interface GenomeTrackEditBlock {
  id: string;
  position: number;
  reference: string;
  alternate: string;
  enabled: boolean;
  copy: "one" | "two" | "unknown";
  label?: string;
  consequence?: string;
  generatedByDeviceId?: string;
}

export interface GenomeTrackAlleleMark {
  id: string;
  position: number;
  reference: string;
  alternate: string;
  origin: "observed" | "edited" | "created";
}

export interface OptimizerObjective {
  id: string;
  label: string;
  description: string;
}

export interface OptimizerWeightControl {
  id: string;
  label: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface GenomeOptimizerSettings {
  objectiveId: string;
  direction: OptimizerDirection;
  weights: Record<string, number>;
  maxEdits: number;
}

export interface GenomeOptimizerResult {
  generatedEdits: number;
  beforeScore?: number;
  afterScore?: number;
  scoreUnit?: string;
  summary?: string;
}

export interface GenomeOptimizerDevice {
  id: string;
  name?: string;
  bypassed: boolean;
  status: OptimizerStatus;
  settings: GenomeOptimizerSettings;
  result?: GenomeOptimizerResult;
  generatedEditIds?: string[];
  message?: string;
  rackOrder?: number;
  target?: RackDeviceTarget;
  resource?: string;
  version?: string;
  limitation?: string;
}

export interface AlleleRandomizerSettings {
  amount: number;
  seed: number;
}

export interface AlleleRandomizerPreview {
  selectedPositions: number;
  randomizedPositions: number;
  generatedEdits: number;
  excludedPositions: number;
  changes: Array<{ position: number; from: string; to: string }>;
  message?: string;
}

export interface AlleleRandomizerDevice {
  id: string;
  name: string;
  bypassed: boolean;
  status: OptimizerStatus;
  settings: AlleleRandomizerSettings;
  preview?: AlleleRandomizerPreview;
  generatedEditIds?: string[];
  message?: string;
  rackOrder?: number;
  version?: string;
  limitation?: string;
}

/** A compact, controlled device card in the selected track's ordered rack. */
export interface RackDeviceView {
  id: string;
  name: string;
  kind: RackDeviceKind;
  target: RackDeviceTarget;
  order: number;
  bypassed: boolean;
  status: RackDeviceStatus;
  resource?: string;
  version?: string;
  result?: string;
  limitation?: string;
  canRun?: boolean;
  runLabel?: string;
}

export interface TrackMeterItem {
  editId: string;
  label: string;
  enabled: boolean;
  evaluated: boolean;
  impactDelta?: number;
}

export interface TrackMeterModel {
  evaluatedMutations: number;
  activeMutations: number;
  impactDelta?: number;
  deviceCoverage: Array<{ id: string; label: string; evaluated: number; total: number; exactMatches: number }>;
  items: TrackMeterItem[];
}

export interface GenomeTrackModel {
  id: string;
  name: string;
  kind: GenomeTrackKind;
  visible: boolean;
  edits: GenomeTrackEditBlock[];
  alleles: GenomeTrackAlleleMark[];
  totalEditCount?: number;
  randomizer?: AlleleRandomizerDevice;
  optimizer?: GenomeOptimizerDevice;
}

export interface TrackDeviceWorkspaceProps {
  region: FocusContext;
  tracks: GenomeTrackModel[];
  selectedTrackId: string;
  selectedEditId?: string;
  selectedAlleleId?: string;
  selectedAlleleIds?: string[];
  objectives: OptimizerObjective[];
  weightControls: OptimizerWeightControl[];
  rackDevices?: RackDeviceView[];
  trackMeter?: TrackMeterModel;
  showTrackMeter?: boolean;
  selectedDeviceId?: string;
  selectedPosition?: number;
  contigLength?: number;
  busy?: boolean;
  detailPanel?: ReactNode;
  onViewportChange?: (region: FocusContext) => void;
  onSelectTrack: (trackId: string) => void;
  onDuplicateTrack: (trackId: string) => void;
  onRenameTrack: (trackId: string, name: string) => void;
  onDeleteTrack: (trackId: string) => void;
  onToggleTrackVisibility: (trackId: string, visible: boolean) => void;
  onSelectEdit: (trackId: string, editId: string) => void;
  onSelectAllele: (trackId: string, alleleId: string) => void;
  onSelectAllAlleles?: (trackId: string) => void;
  onClearAlleleSelection?: () => void;
  onToggleEdit: (trackId: string, editId: string, enabled: boolean) => void;
  onOptimizerChange: (trackId: string, settings: GenomeOptimizerSettings) => void;
  onOptimizerBypass: (trackId: string, bypassed: boolean) => void;
  onRegenerate: (trackId: string) => void;
  onConsolidate: (trackId: string) => void;
  onRandomizerChange?: (trackId: string, settings: AlleleRandomizerSettings) => void;
  onRandomizerPreview?: (trackId: string) => void;
  onRandomizerApply?: (trackId: string) => void;
  onRandomizerBypass?: (trackId: string, bypassed: boolean) => void;
  onSelectDevice?: (trackId: string, deviceId: string) => void;
  onToggleDevice?: (trackId: string, deviceId: string, bypassed: boolean) => void;
  onRunDevice?: (trackId: string, deviceId: string) => void;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function positionPercent(position: number, region: FocusContext) {
  const span = Math.max(1, region.end - region.start);
  return clamp(((position - region.start) / span) * 100, 0, 100);
}

function niceTickStep(span: number) {
  const roughStep = Math.max(1, span / 8);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

function viewportTicks(region: FocusContext) {
  const step = niceTickStep(viewportSpan(region));
  const first = Math.ceil(region.start / step) * step;
  const ticks: number[] = [];
  for (let position = first; position <= region.end; position += step) ticks.push(position);
  return ticks;
}

function alleleLabel(edit: GenomeTrackEditBlock) {
  return edit.label ?? `${edit.reference}→${edit.alternate}`;
}

function compactAllele(reference: string, alternate: string) {
  const shorten = (allele: string) => allele.length > 7 ? `${allele.slice(0, 5)}…` : allele;
  return `${shorten(reference)}→${shorten(alternate)}`;
}

function copyLabel(copy: GenomeTrackEditBlock["copy"]) {
  if (copy === "one") return "chromosome copy A";
  if (copy === "two") return "chromosome copy B";
  return "chromosome copy unknown";
}

function TrackRail({
  track,
  region,
  selected,
  selectedEditId,
  selectedAlleleId,
  selectedAlleleIds = [],
  busy,
  onSelect,
  onDuplicate,
  onRename,
  onDelete,
  onToggleVisibility,
  onSelectEdit,
  onSelectAllele,
  onToggleEdit
}: {
  track: GenomeTrackModel;
  region: FocusContext;
  selected: boolean;
  selectedEditId?: string;
  selectedAlleleId?: string;
  selectedAlleleIds?: string[];
  busy: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onToggleVisibility: (visible: boolean) => void;
  onSelectEdit: (editId: string) => void;
  onSelectAllele: (alleleId: string) => void;
  onToggleEdit: (editId: string, enabled: boolean) => void;
}) {
  const isSource = track.kind === "source";
  const [draftName, setDraftName] = useState(track.name);
  const showBaseGrid = viewportSpan(region) <= 240;
  const compactAlleles = viewportSpan(region) > 2_000;

  useEffect(() => setDraftName(track.name), [track.name]);

  function commitName() {
    const normalized = draftName.trim();
    if (!normalized) {
      setDraftName(track.name);
      return;
    }
    if (normalized !== track.name) onRename(normalized);
  }

  return (
    <article className={`dgw-track ${isSource ? "is-source" : "is-candidate"}${selected ? " is-selected" : ""}${track.visible ? "" : " is-hidden"}`}>
      <div className="dgw-track-controls">
        <button
          className="dgw-track-select"
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          disabled={busy}
        >
          <span className={`dgw-track-kind ${track.kind}`}>{isSource ? "Source" : "Candidate"}</span>
          <span className="dgw-track-select-label">{selected ? "Selected" : "Select"}</span>
        </button>
        <label className="dgw-track-name">
          <span className="dgw-visually-hidden">Track name</span>
          <input
            value={draftName}
            readOnly={isSource}
            aria-label={`${isSource ? "Source" : "Candidate"} track name`}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraftName(track.name);
                event.currentTarget.blur();
              }
            }}
            disabled={busy}
          />
        </label>
        <div className="dgw-track-actions" aria-label={`Actions for ${track.name}`}>
          <button type="button" onClick={onDuplicate} disabled={busy} title="Duplicate track">Duplicate</button>
          <button
            type="button"
            className={track.visible ? "is-on" : ""}
            aria-pressed={track.visible}
            onClick={() => onToggleVisibility(!track.visible)}
            disabled={busy}
          >
            {track.visible ? "Shown" : "Hidden"}
          </button>
          {!isSource && <button type="button" className="danger" onClick={onDelete} disabled={busy}>Delete</button>}
        </div>
      </div>

      <div
        className={`dgw-track-lane${showBaseGrid ? " is-base-scale" : ""}${compactAlleles ? " is-allele-compact" : ""}`}
        aria-label={`${track.name} edits in the focused region`}
        style={{ "--dgw-base-width": `${100 / viewportSpan(region)}%` } as CSSProperties}
      >
        <div className="dgw-lane-grid" aria-hidden="true">
          {showBaseGrid && Array.from({ length: viewportSpan(region) }, (_, index) => region.start + index).map((position) => (
            <i className="base" key={`base-${position}`} style={{ left: `${positionPercent(position, region)}%` }} />
          ))}
          {viewportTicks(region).map((position) => (
            <i className="major" key={position} style={{ left: `${positionPercent(position, region)}%` }} />
          ))}
        </div>
        <div className="dgw-track-baseline" />
        {(track.alleles ?? []).map((allele) => (
          <button
            type="button"
            className={`dgw-allele-mark ${allele.origin}${selected && (selectedAlleleIds?.includes(allele.id) || allele.id === selectedAlleleId) ? " is-selected" : ""}`}
            key={allele.id}
            style={{ left: `${positionPercent(allele.position, region)}%` }}
            title={`${isSource ? "Inspect protected source allele" : "Edit candidate allele"} · ${region.contig}:${allele.position.toLocaleString()} ${allele.reference}→${allele.alternate}`}
            aria-label={`${isSource ? "Inspect source" : "Edit candidate"} allele ${region.contig}:${allele.position} ${allele.reference} to ${allele.alternate}`}
            onClick={() => onSelectAllele(allele.id)}
            disabled={busy}
          >
            <span className="dgw-allele-stem" />
            <span className="dgw-allele-head" />
            <span className="dgw-allele-label"><small>{isSource ? "SRC" : "EDIT"}</small>{compactAllele(allele.reference, allele.alternate)}</span>
          </button>
        ))}
        {isSource && (track.alleles?.length ?? 0) === 0 && <span className="dgw-track-origin">No alternate alleles in view</span>}
        {track.edits.map((edit) => {
          const left = positionPercent(edit.position, region);
          const isEditSelected = edit.id === selectedEditId;
          const title = `${region.contig}:${edit.position.toLocaleString()} ${edit.reference}→${edit.alternate} · ${copyLabel(edit.copy)}${edit.consequence ? ` · ${edit.consequence}` : ""}`;
          return (
            <div
              className={`dgw-edit-anchor${edit.enabled ? "" : " is-bypassed"}${isEditSelected ? " is-selected" : ""}`}
              style={{ left: `${left}%` }}
              key={edit.id}
            >
              <button
                type="button"
                className="dgw-edit-block"
                title={title}
                aria-label={`Select edit ${title}`}
                aria-pressed={isEditSelected}
                onClick={() => onSelectEdit(edit.id)}
                disabled={busy}
              >
                <span>{alleleLabel(edit)}</span>
                <small>{edit.position.toLocaleString()}</small>
              </button>
              <button
                type="button"
                className="dgw-edit-power"
                aria-label={`${edit.enabled ? "Bypass" : "Enable"} ${alleleLabel(edit)} edit`}
                aria-pressed={edit.enabled}
                onClick={() => onToggleEdit(edit.id, !edit.enabled)}
                disabled={busy}
                title={edit.enabled ? "Bypass edit" : "Enable edit"}
              >
                {edit.enabled ? "on" : "off"}
              </button>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function NumberKnob({
  label,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const progress = (clamp(value, min, max) - min) / Math.max(1, max - min);
  const angle = -135 + progress * 270;
  const style = { "--dgw-knob-angle": `${angle}deg` } as CSSProperties;

  return (
    <label className="dgw-number-knob">
      <span className="dgw-knob-face" style={style} aria-hidden="true"><i /></span>
      <span className="dgw-knob-label">{label}</span>
      <span className="dgw-knob-value">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          aria-label={label}
          onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
          disabled={disabled}
        />
        {suffix && <small>{suffix}</small>}
      </span>
    </label>
  );
}

function rackTargetLabel(target: RackDeviceTarget) {
  return target === "selectedAllele" ? "Selected allele" : "Focused region";
}

function rackStatusLabel(status: RackDeviceStatus) {
  const labels: Record<RackDeviceStatus, string> = {
    idle: "Idle",
    ready: "Ready",
    running: "Running",
    stale: "Needs update",
    error: "Error",
    complete: "Complete",
    found: "Match found",
    noExactMatch: "No exact match",
    notComputed: "Not run",
    resourceUnavailable: "Unavailable"
  };
  return labels[status];
}

function CompactDeviceCard({
  device,
  selected,
  busy,
  onSelect,
  onToggle,
  onRun
}: {
  device: RackDeviceView;
  selected: boolean;
  busy: boolean;
  onSelect?: () => void;
  onToggle?: (bypassed: boolean) => void;
  onRun?: () => void;
}) {
  const running = device.status === "running";
  const disabled = busy || running;
  const resource = [device.resource, device.version].filter(Boolean).join(" · ") || "Project resource";

  return (
    <section
      className={`dgw-rack-device-card${selected ? " is-selected" : ""}${device.bypassed ? " is-bypassed" : ""}`}
      aria-label={`${device.name} device`}
    >
      <header className="dgw-compact-device-header">
        <button type="button" className="dgw-device-identity" onClick={onSelect} disabled={!onSelect || busy}>
          <span className={`dgw-device-light ${device.status}`} aria-hidden="true" />
          <span>
            <small>{device.kind}</small>
            <b>{device.name}</b>
          </span>
        </button>
        <button
          type="button"
          className={`dgw-bypass ${device.bypassed ? "is-active" : ""}`}
          aria-pressed={!device.bypassed}
          aria-label={`${device.name} is ${device.bypassed ? "bypassed" : "active"}. Toggle device.`}
          onClick={() => onToggle?.(!device.bypassed)}
          disabled={!onToggle || disabled}
        >
          {device.bypassed ? "Bypassed" : "Active"}
        </button>
      </header>

      <dl className="dgw-device-metadata">
        <div><dt>Target</dt><dd>{rackTargetLabel(device.target)}</dd></div>
        <div><dt>Resource</dt><dd title={resource}>{resource}</dd></div>
        <div><dt>Status</dt><dd><span className={`dgw-rack-status ${device.status}`}>{rackStatusLabel(device.status)}</span></dd></div>
      </dl>

      <div className="dgw-compact-result" aria-live="polite">
        <small>Result</small>
        <b>{running ? "Running…" : device.result ?? "No result yet"}</b>
      </div>
      <p className="dgw-device-limitation"><b>Limit</b>{device.limitation ?? "Interpret this result only within the stated target."}</p>

      <footer className="dgw-compact-device-actions">
        <button type="button" onClick={onSelect} disabled={!onSelect || busy}>Inspect</button>
        <button
          type="button"
          className="primary"
          onClick={onRun}
          disabled={!onRun || disabled || device.bypassed || device.canRun === false}
        >
          {running ? "Running…" : device.runLabel ?? "Run"}
        </button>
      </footer>
    </section>
  );
}

function OptimizerDeviceCard({
  track,
  device,
  objectives,
  weightControls,
  selected,
  busy,
  onSelect,
  onChange,
  onBypass,
  onRegenerate,
  onConsolidate
}: {
  track: GenomeTrackModel;
  device: GenomeOptimizerDevice;
  objectives: OptimizerObjective[];
  weightControls: OptimizerWeightControl[];
  selected: boolean;
  busy: boolean;
  onSelect?: () => void;
  onChange: (settings: GenomeOptimizerSettings) => void;
  onBypass: (bypassed: boolean) => void;
  onRegenerate: () => void;
  onConsolidate: () => void;
}) {
  const settings = device.settings;
  const disabled = busy || device.status === "running";
  const objective = objectives.find((item) => item.id === settings.objectiveId);
  const update = (patch: Partial<GenomeOptimizerSettings>) => onChange({ ...settings, ...patch });
  const resource = [device.resource, device.version].filter(Boolean).join(" · ") || "Configured evidence devices";

  return (
    <section className={`dgw-optimizer${selected ? " is-selected" : ""}${device.bypassed ? " is-bypassed" : ""}`} aria-label={device.name ?? "Genome Optimizer"}>
      <header className="dgw-device-header">
        <button type="button" className="dgw-device-identity" onClick={onSelect} disabled={!onSelect || busy}>
          <span className={`dgw-device-light ${device.status}`} aria-hidden="true" />
          <span><small>editing</small><b>{device.name ?? "Genome Optimizer"}</b></span>
        </button>
        <button
          type="button"
          className={`dgw-bypass ${device.bypassed ? "is-active" : ""}`}
          aria-pressed={!device.bypassed}
          aria-label={`${device.name ?? "Genome Optimizer"} is ${device.bypassed ? "bypassed" : "active"}. Toggle device.`}
          onClick={() => onBypass(!device.bypassed)}
          disabled={disabled}
        >
          {device.bypassed ? "Bypassed" : "Active"}
        </button>
      </header>

      <dl className="dgw-device-metadata optimizer-metadata">
        <div><dt>Target</dt><dd>{rackTargetLabel(device.target ?? "focusedRegion")}</dd></div>
        <div><dt>Resources</dt><dd title={resource}>{resource}</dd></div>
        <div><dt>Status</dt><dd><span className={`dgw-rack-status ${device.status}`}>{rackStatusLabel(device.status)}</span></dd></div>
      </dl>

      <div className="dgw-device-objective">
        <label>
          Objective
          <select
            value={settings.objectiveId}
            onChange={(event) => update({ objectiveId: event.target.value })}
            disabled={disabled}
          >
            {objectives.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
          </select>
        </label>
        <div className="dgw-direction" role="group" aria-label="Optimization direction">
          <button
            type="button"
            className={settings.direction === "minimize" ? "is-active" : ""}
            aria-pressed={settings.direction === "minimize"}
            onClick={() => update({ direction: "minimize" })}
            disabled={disabled}
          >
            Minimize
          </button>
          <button
            type="button"
            className={settings.direction === "maximize" ? "is-active" : ""}
            aria-pressed={settings.direction === "maximize"}
            onClick={() => update({ direction: "maximize" })}
            disabled={disabled}
          >
            Maximize
          </button>
        </div>
        <p>{objective?.description ?? "Choose a named score before generating candidate edits."}</p>
      </div>

      <div className="dgw-fader-bank" aria-label="Scoring weights">
        {weightControls.map((control) => {
          const min = control.min ?? 0;
          const max = control.max ?? 100;
          const step = control.step ?? 5;
          const value = clamp(settings.weights[control.id] ?? min, min, max);
          return (
            <label className="dgw-fader" key={control.id} title={control.description}>
              <output>{value}</output>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                aria-label={`${control.label} scoring weight`}
                onChange={(event) => update({
                  weights: { ...settings.weights, [control.id]: Number(event.target.value) }
                })}
                disabled={disabled}
              />
              <span>{control.label}</span>
            </label>
          );
        })}
      </div>
      <p className="dgw-control-note">Faders tune the relative weight of each evidence score. They never blend bases: every proposed allele is discrete.</p>

      <div className="dgw-knob-bank single">
        <NumberKnob
          label="Maximum edits"
          value={settings.maxEdits}
          min={1}
          max={20}
          step={1}
          disabled={disabled}
          onChange={(maxEdits) => update({ maxEdits })}
        />
      </div>

      <div className="dgw-device-result" aria-live="polite">
        <span>{device.status === "running" ? "Generating…" : device.message ?? "Ready to generate candidates"}</span>
        {device.result && (
          <div>
            <b>{device.result.generatedEdits} discrete edits</b>
            {device.result.beforeScore !== undefined && device.result.afterScore !== undefined && (
              <small>
                {device.result.beforeScore.toLocaleString()} → {device.result.afterScore.toLocaleString()} {device.result.scoreUnit}
              </small>
            )}
            {device.result.summary && <small>{device.result.summary}</small>}
          </div>
        )}
      </div>
      <p className="dgw-device-limitation optimizer-limit"><b>Limit</b>{device.limitation ?? "Nearby allele scores remain independent; this device does not infer a combined biological effect."}</p>

      <footer className="dgw-device-actions">
        <button type="button" onClick={onRegenerate} disabled={disabled || device.bypassed}>
          {device.status === "running" ? "Generating…" : device.result ? "Regenerate" : "Generate edits"}
        </button>
        <button
          type="button"
          className="primary"
          onClick={onConsolidate}
          disabled={disabled || device.bypassed || (track.totalEditCount ?? track.edits.length) === 0}
          title="Materialize enabled edits into a new track baseline"
        >
          Consolidate
        </button>
      </footer>
      <p className="dgw-consolidate-note">Consolidation moves the entire current effective genome into this track’s visual baseline. Full edit ancestry remains in the audit trail.</p>
    </section>
  );
}

function RandomizerDeviceCard({
  device,
  selectedCount,
  selected,
  busy,
  onSelect,
  onChange,
  onPreview,
  onApply,
  onBypass
}: {
  device: AlleleRandomizerDevice;
  selectedCount: number;
  selected: boolean;
  busy: boolean;
  onSelect?: () => void;
  onChange: (settings: AlleleRandomizerSettings) => void;
  onPreview: () => void;
  onApply: () => void;
  onBypass: (bypassed: boolean) => void;
}) {
  const disabled = busy || device.status === "running";
  const preview = device.preview;
  const update = (patch: Partial<AlleleRandomizerSettings>) => onChange({ ...device.settings, ...patch });
  return <section className={`dgw-randomizer${selected ? " is-selected" : ""}${device.bypassed ? " is-bypassed" : ""}`} aria-label="Allele Randomizer">
    <header className="dgw-device-header">
      <button type="button" className="dgw-device-identity" onClick={onSelect} disabled={!onSelect || busy}>
        <span className={`dgw-device-light ${device.status}`} aria-hidden="true" />
        <span><small>editing</small><b>{device.name}</b></span>
      </button>
      <button type="button" className={`dgw-bypass ${device.bypassed ? "is-active" : ""}`} aria-pressed={!device.bypassed} onClick={() => onBypass(!device.bypassed)} disabled={disabled}>
        {device.bypassed ? "Bypassed" : "Active"}
      </button>
    </header>
    <dl className="dgw-device-metadata optimizer-metadata">
      <div><dt>Target</dt><dd>{selectedCount} selected {selectedCount === 1 ? "position" : "positions"}</dd></div>
      <div><dt>Mode</dt><dd>Canonical SNVs</dd></div>
      <div><dt>Status</dt><dd><span className={`dgw-rack-status ${device.status}`}>{rackStatusLabel(device.status)}</span></dd></div>
    </dl>
    <div className="dgw-randomizer-controls">
      <label>
        <span>Amount <output>{device.settings.amount}%</output></span>
        <input type="range" min={0} max={100} step={1} value={device.settings.amount} onChange={(event) => update({ amount: Number(event.currentTarget.value) })} disabled={disabled} />
      </label>
      <label>
        <span>Seed</span>
        <input type="number" min={0} step={1} value={device.settings.seed} onChange={(event) => update({ seed: Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0)) })} disabled={disabled} />
      </label>
    </div>
    <div className="dgw-randomizer-result" aria-live="polite">
      {preview ? <>
        <b>{preview.randomizedPositions}/{preview.selectedPositions} positions · {preview.generatedEdits} mutation blocks</b>
        {preview.excludedPositions > 0 && <small>{preview.excludedPositions} unsupported or unavailable positions skipped</small>}
        {preview.message && <small>{preview.message}</small>}
        <div className="dgw-randomizer-changes">
          {preview.changes.slice(0, 8).map((change) => <code key={`${change.position}-${change.from}-${change.to}`}>{change.position.toLocaleString()} {change.from}→{change.to}</code>)}
          {preview.changes.length > 8 && <small>+{preview.changes.length - 8} more</small>}
        </div>
      </> : <span>{device.message ?? "Select visible alleles, then preview a deterministic randomization."}</span>}
    </div>
    <p className="dgw-device-limitation optimizer-limit"><b>Limit</b>{device.limitation}</p>
    <footer className="dgw-device-actions">
      <button type="button" onClick={onPreview} disabled={disabled || device.bypassed || selectedCount === 0}>Preview</button>
      <button type="button" className="primary" onClick={onApply} disabled={disabled || device.bypassed || !preview || preview.generatedEdits === 0}>Apply as blocks</button>
    </footer>
  </section>;
}

function TrackMeterCard({ meter }: { meter: TrackMeterModel }) {
  const complete = meter.activeMutations > 0 && meter.evaluatedMutations === meter.activeMutations;
  const delta = complete ? meter.impactDelta : undefined;
  const scale = Math.max(1, meter.activeMutations);
  const fill = delta === undefined ? 0 : Math.min(50, (Math.abs(delta) / scale) * 50);
  const state = delta === undefined ? "incomplete" : delta > 0 ? "red" : delta < 0 ? "green" : "zero";
  return <section className={`dgw-track-meter ${state}`} aria-label="Track Meter">
    <header>
      <div><small>Master</small><b>Track Meter</b></div>
      <span>{meter.evaluatedMutations}/{meter.activeMutations} mutations</span>
    </header>
    <div className="dgw-meter-body">
      <div className="dgw-master-scale" aria-label={delta === undefined ? "Impact delta incomplete" : `Impact delta ${delta.toFixed(2)}`}>
        <div className="dgw-red-zone" />
        <div className="dgw-meter-zero"><span>0</span></div>
        {delta !== undefined && <div className={`dgw-meter-fill ${delta > 0 ? "positive" : "negative"}`} style={{ height: `${fill}%` }} />}
      </div>
      <div className="dgw-meter-readout">
        <small>SnpEff molecular-impact Δ</small>
        <strong>{delta === undefined ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`}</strong>
        <span>{delta === undefined ? "Evaluate every active mutation" : delta > 0 ? "Above source · red" : delta < 0 ? "Below source" : "Same as source"}</span>
      </div>
    </div>
    <div className="dgw-meter-devices">
      {meter.deviceCoverage.map((device) => <div key={device.id} title={`${device.exactMatches} exact-match results`}>
        <span>{device.label}</span><b>{device.evaluated}/{device.total}</b>
      </div>)}
    </div>
    <div className="dgw-meter-edits">
      {meter.items.length === 0 ? <p>No active mutation blocks yet.</p> : meter.items.map((item) => <div className={`${item.enabled ? "" : "bypassed"}${item.evaluated ? " evaluated" : ""}`} key={item.editId}>
        <span>{item.label}</span>
        <b>{!item.enabled ? "bypassed" : item.impactDelta === undefined ? "not evaluated" : `${item.impactDelta >= 0 ? "+" : ""}${item.impactDelta.toFixed(2)}`}</b>
      </div>)}
    </div>
    <p className="dgw-meter-limit">Additive allele-level signal. It is not disease probability and does not model combined effects.</p>
  </section>;
}

function DeviceRack({
  track,
  selectedAlleleCount,
  rackDevices,
  selectedDeviceId,
  objectives,
  weightControls,
  busy,
  onOptimizerChange,
  onOptimizerBypass,
  onRegenerate,
  onConsolidate,
  onRandomizerChange,
  onRandomizerPreview,
  onRandomizerApply,
  onRandomizerBypass,
  onSelectDevice,
  onToggleDevice,
  onRunDevice
}: {
  track?: GenomeTrackModel;
  selectedAlleleCount: number;
  rackDevices: RackDeviceView[];
  selectedDeviceId?: string;
  objectives: OptimizerObjective[];
  weightControls: OptimizerWeightControl[];
  busy: boolean;
  onOptimizerChange: (settings: GenomeOptimizerSettings) => void;
  onOptimizerBypass: (bypassed: boolean) => void;
  onRegenerate: () => void;
  onConsolidate: () => void;
  onRandomizerChange?: (settings: AlleleRandomizerSettings) => void;
  onRandomizerPreview?: () => void;
  onRandomizerApply?: () => void;
  onRandomizerBypass?: (bypassed: boolean) => void;
  onSelectDevice?: (deviceId: string) => void;
  onToggleDevice?: (deviceId: string, bypassed: boolean) => void;
  onRunDevice?: (deviceId: string) => void;
}) {
  if (!track) {
    return <aside className="dgw-device-rack is-empty"><p>Select a genome track to see its devices.</p></aside>;
  }

  const compactDevices = rackDevices.filter((item) => item.id !== track.optimizer?.id && item.id !== track.randomizer?.id);
  const rackItems: Array<
    | { type: "optimizer"; order: number; device: GenomeOptimizerDevice }
    | { type: "randomizer"; order: number; device: AlleleRandomizerDevice }
    | { type: "compact"; order: number; device: RackDeviceView }
  > = compactDevices.map((device) => ({ type: "compact", order: device.order, device }));
  if (track.optimizer) {
    rackItems.push({ type: "optimizer", order: track.optimizer.rackOrder ?? 0, device: track.optimizer });
  }
  if (track.randomizer) {
    rackItems.push({ type: "randomizer", order: track.randomizer.rackOrder ?? 0, device: track.randomizer });
  }
  rackItems.sort((left, right) => left.order - right.order || left.device.id.localeCompare(right.device.id));

  return (
    <aside className={`dgw-device-rack${rackItems.length === 0 ? " is-empty" : ""}`}>
      <div className="dgw-device-rack-title">
        <span>Device rack</span>
        <small>{track.name} · {rackItems.length} {rackItems.length === 1 ? "device" : "devices"}</small>
      </div>

      {rackItems.length === 0 ? (
        <p>{track.kind === "source" ? "No analysis devices are available for this track." : "This track has no devices."}</p>
      ) : (
        <div className="dgw-device-chain" aria-label={`Ordered devices for ${track.name}`}>
          {rackItems.map((item) => item.type === "optimizer" ? (
            <OptimizerDeviceCard
              key={item.device.id}
              track={track}
              device={item.device}
              objectives={objectives}
              weightControls={weightControls}
              selected={selectedDeviceId === item.device.id}
              busy={busy}
              onSelect={onSelectDevice ? () => onSelectDevice(item.device.id) : undefined}
              onChange={onOptimizerChange}
              onBypass={onOptimizerBypass}
              onRegenerate={onRegenerate}
              onConsolidate={onConsolidate}
            />
          ) : item.type === "randomizer" ? (
            <RandomizerDeviceCard
              key={item.device.id}
              device={item.device}
              selectedCount={selectedAlleleCount}
              selected={selectedDeviceId === item.device.id}
              busy={busy}
              onSelect={onSelectDevice ? () => onSelectDevice(item.device.id) : undefined}
              onChange={onRandomizerChange ?? (() => undefined)}
              onPreview={onRandomizerPreview ?? (() => undefined)}
              onApply={onRandomizerApply ?? (() => undefined)}
              onBypass={onRandomizerBypass ?? (() => undefined)}
            />
          ) : (
            <CompactDeviceCard
              key={item.device.id}
              device={item.device}
              selected={selectedDeviceId === item.device.id}
              busy={busy}
              onSelect={onSelectDevice ? () => onSelectDevice(item.device.id) : undefined}
              onToggle={onToggleDevice ? (bypassed) => onToggleDevice(item.device.id, bypassed) : undefined}
              onRun={onRunDevice ? () => onRunDevice(item.device.id) : undefined}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

export function TrackDeviceWorkspace({
  region,
  tracks,
  selectedTrackId,
  selectedEditId,
  selectedAlleleId,
  selectedAlleleIds = [],
  objectives,
  weightControls,
  rackDevices = [],
  trackMeter,
  showTrackMeter = true,
  selectedDeviceId,
  selectedPosition,
  contigLength,
  busy = false,
  detailPanel,
  onViewportChange,
  onSelectTrack,
  onDuplicateTrack,
  onRenameTrack,
  onDeleteTrack,
  onToggleTrackVisibility,
  onSelectEdit,
  onSelectAllele,
  onSelectAllAlleles,
  onClearAlleleSelection,
  onToggleEdit,
  onOptimizerChange,
  onOptimizerBypass,
  onRegenerate,
  onConsolidate,
  onRandomizerChange,
  onRandomizerPreview,
  onRandomizerApply,
  onRandomizerBypass,
  onSelectDevice,
  onToggleDevice,
  onRunDevice
}: TrackDeviceWorkspaceProps) {
  const selectedTrack = tracks.find((track) => track.id === selectedTrackId);
  const span = viewportSpan(region);
  const ticks = viewportTicks(region);
  const [trackHeight, setTrackHeight] = useState(() => {
    const stored = Number(window.localStorage.getItem("dgw.track-height"));
    return Number.isFinite(stored) && stored >= 76 && stored <= 220 ? stored : 100;
  });

  useEffect(() => {
    window.localStorage.setItem("dgw.track-height", String(trackHeight));
  }, [trackHeight]);

  function updateViewport(next: FocusContext) {
    if (next.start !== region.start || next.end !== region.end || next.contig !== region.contig) {
      onViewportChange?.(next);
    }
  }

  function zoom(factor: number, anchor = 0.5) {
    updateViewport(zoomViewport(region, factor, anchor, contigLength));
  }

  function pan(fraction: number) {
    updateViewport(panViewport(region, span * fraction, contigLength));
  }

  function scrollTo(center: number) {
    const currentCenter = region.start + (span - 1) / 2;
    updateViewport(panViewport(region, center - currentCenter, contigLength));
  }

  function handleTrackWheel(event: WheelEvent<HTMLDivElement>) {
    if (busy || !onViewportChange) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    const lane = event.currentTarget.querySelector<HTMLElement>(".dgw-track-lane");
    const bounds = lane?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const anchor = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
      zoom(Math.exp(clamp(event.deltaY, -240, 240) * 0.0025), anchor);
      return;
    }
    const lateralDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.shiftKey
        ? event.deltaY
        : 0;
    if (lateralDelta !== 0) {
      event.preventDefault();
      updateViewport(panViewport(region, (lateralDelta / Math.max(1, bounds.width)) * span, contigLength));
    }
  }

  useEffect(() => {
    if (!onViewportChange) return;
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea, [contenteditable=true]")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && onSelectAllAlleles) {
        event.preventDefault();
        onSelectAllAlleles(selectedTrackId);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoom(0.625);
      } else if (event.key === "-") {
        event.preventDefault();
        zoom(1.6);
      } else if (event.key === "ArrowLeft" && event.shiftKey) {
        event.preventDefault();
        pan(-0.25);
      } else if (event.key === "ArrowRight" && event.shiftKey) {
        event.preventDefault();
        pan(0.25);
      } else if (event.key === "0" && selectedPosition !== undefined) {
        event.preventDefault();
        updateViewport(focusViewport(region, selectedPosition, contigLength));
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [contigLength, onSelectAllAlleles, onViewportChange, region, selectedPosition, selectedTrackId, span]);

  return (
    <section
      className="dgw-track-device-workspace"
      aria-label="Genome tracks and device rack"
      style={{ "--dgw-track-height": `${trackHeight}px` } as CSSProperties}
    >
      <div className="dgw-track-deck" onWheel={handleTrackWheel}>
        <header className="dgw-track-deck-header">
          <div>
            <span>Genome tracks</span>
            <small><b>◇</b> lollipop = VCF allele · rectangle = mutation block</small>
            <small>Ctrl/⌘ + wheel zooms · Shift + wheel pans laterally.</small>
          </div>
          <div className="dgw-viewport-controls" aria-label="Horizontal genome zoom controls">
            <button type="button" onClick={() => pan(-0.35)} disabled={busy || !onViewportChange} title="Pan left">‹</button>
            <button type="button" onClick={() => zoom(1.6)} disabled={busy || !onViewportChange} title="Zoom out">−</button>
            <code>{region.contig}:{region.start.toLocaleString()}–{region.end.toLocaleString()} <small>{span.toLocaleString()} bp</small></code>
            <button type="button" onClick={() => zoom(0.625)} disabled={busy || !onViewportChange} title="Zoom in">+</button>
            <button type="button" onClick={() => pan(0.35)} disabled={busy || !onViewportChange} title="Pan right">›</button>
            <button
              type="button"
              className="fit"
              onClick={() => selectedPosition !== undefined && updateViewport(focusViewport(region, selectedPosition, contigLength))}
              disabled={busy || !onViewportChange || selectedPosition === undefined}
              title="Fit selected allele (0)"
            >Fit allele</button>
            <span className="dgw-selection-controls" aria-label="Allele selection controls">
              <button type="button" onClick={() => onSelectAllAlleles?.(selectedTrackId)} disabled={busy || !onSelectAllAlleles || (selectedTrack?.alleles.length ?? 0) === 0} title="Select every visible VCF allele (Ctrl/Command+A)">Select all</button>
              <button type="button" onClick={onClearAlleleSelection} disabled={busy || !onClearAlleleSelection || selectedAlleleIds.length === 0}>Clear</button>
              <small>{selectedAlleleIds.length} selected</small>
            </span>
            <span className="dgw-height-controls" aria-label="Track height controls">
              <small>Height</small>
              <button
                type="button"
                onClick={() => setTrackHeight((height) => Math.max(76, height - 24))}
                disabled={trackHeight <= 76}
                title="Make tracks shorter"
              >−</button>
              <button
                type="button"
                onClick={() => setTrackHeight((height) => Math.min(220, height + 24))}
                disabled={trackHeight >= 220}
                title="Make tracks taller"
              >+</button>
            </span>
          </div>
        </header>

        <div className="dgw-region-ruler" aria-hidden="true">
          {ticks.map((position) => (
            <span key={position} style={{ left: `${positionPercent(position, region)}%` }}>
              <i />
              <b>{position.toLocaleString()}</b>
            </span>
          ))}
        </div>

        <div className="dgw-track-list">
          {tracks.map((track) => (
            <TrackRail
              key={track.id}
              track={track}
              region={region}
              selected={track.id === selectedTrackId}
              selectedEditId={selectedEditId}
              selectedAlleleId={selectedAlleleId}
              selectedAlleleIds={selectedAlleleIds}
              busy={busy}
              onSelect={() => onSelectTrack(track.id)}
              onDuplicate={() => onDuplicateTrack(track.id)}
              onRename={(name) => onRenameTrack(track.id, name)}
              onDelete={() => onDeleteTrack(track.id)}
              onToggleVisibility={(visible) => onToggleTrackVisibility(track.id, visible)}
              onSelectEdit={(editId) => onSelectEdit(track.id, editId)}
              onSelectAllele={(alleleId) => onSelectAllele(track.id, alleleId)}
              onToggleEdit={(editId, enabled) => onToggleEdit(track.id, editId, enabled)}
            />
          ))}
          {tracks.length === 0 && <p className="dgw-track-empty">No genome tracks are available.</p>}
        </div>

        <div className="dgw-horizontal-navigator">
          <span>{region.contig}:1</span>
          <input
            type="range"
            min={1}
            max={contigLength ?? Math.max(region.end, 1)}
            step={Math.max(1, Math.round(span / 100))}
            value={Math.round(region.start + (span - 1) / 2)}
            onChange={(event) => scrollTo(Number(event.currentTarget.value))}
            disabled={busy || !onViewportChange || !contigLength}
            aria-label="Scroll left or right along the contig"
          />
          <span>{contigLength?.toLocaleString() ?? "contig end"}</span>
        </div>
      </div>

      <div className={`dgw-lower-pane${showTrackMeter && trackMeter ? " has-master" : ""}`}>
        <div className="dgw-lower-main">{detailPanel ?? <DeviceRack
          track={selectedTrack}
          selectedAlleleCount={selectedAlleleIds.length}
          rackDevices={rackDevices}
          selectedDeviceId={selectedDeviceId}
          objectives={objectives}
          weightControls={weightControls}
          busy={busy}
          onOptimizerChange={(settings) => selectedTrack && onOptimizerChange(selectedTrack.id, settings)}
          onOptimizerBypass={(bypassed) => selectedTrack && onOptimizerBypass(selectedTrack.id, bypassed)}
          onRegenerate={() => selectedTrack && onRegenerate(selectedTrack.id)}
          onConsolidate={() => selectedTrack && onConsolidate(selectedTrack.id)}
          onRandomizerChange={onRandomizerChange && selectedTrack ? (settings) => onRandomizerChange(selectedTrack.id, settings) : undefined}
          onRandomizerPreview={onRandomizerPreview && selectedTrack ? () => onRandomizerPreview(selectedTrack.id) : undefined}
          onRandomizerApply={onRandomizerApply && selectedTrack ? () => onRandomizerApply(selectedTrack.id) : undefined}
          onRandomizerBypass={onRandomizerBypass && selectedTrack ? (bypassed) => onRandomizerBypass(selectedTrack.id, bypassed) : undefined}
          onSelectDevice={onSelectDevice && selectedTrack ? (deviceId) => onSelectDevice(selectedTrack.id, deviceId) : undefined}
          onToggleDevice={onToggleDevice && selectedTrack ? (deviceId, bypassed) => onToggleDevice(selectedTrack.id, deviceId, bypassed) : undefined}
          onRunDevice={onRunDevice && selectedTrack ? (deviceId) => onRunDevice(selectedTrack.id, deviceId) : undefined}
        />}</div>
        {showTrackMeter && trackMeter && <div className="dgw-master-dock"><TrackMeterCard meter={trackMeter} /></div>}
      </div>
    </section>
  );
}
