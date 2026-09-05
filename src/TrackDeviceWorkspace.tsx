import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, Trash2, Plus, RotateCcw, Power, ZoomIn, ZoomOut, LocateFixed } from "lucide-react";
import { focusViewport, panViewport, viewportSpan, zoomViewport } from "./genomeViewport";
import { scoringInputState } from "./scoringInputs";
import type { FocusContext, MorphOrdering, TrackMorphPreviewResult, VariantDensity } from "./types";
import { sampleVariantMapMarks, variantMapTone, variantMapY } from "./variantMap";
import "./track-device.css";

export type GenomeTrackKind = "source" | "candidate";
export type OptimizerDirection = "minimize" | "maximize";
export type OptimizerStatus = "idle" | "ready" | "running" | "stale" | "error";
export type RackDeviceKind = "editing" | "annotation" | "prediction" | "evidence" | "visualization";
export type RackDeviceTarget = "selectedAllele" | "focusedRegion";
export type RackDeviceStatus =
  | OptimizerStatus
  | "complete"
  | "found"
  | "noExactMatch"
  | "notComputed"
  | "resourceUnavailable";

const DEFAULT_RACK_HEIGHT = 220;
const MIN_RACK_HEIGHT = 160;
const MIN_TRACK_DECK_HEIGHT = 300;
const RACK_SEPARATOR_HEIGHT = 7;
const CONTEXT_MENU_WIDTH = 250;
const CONTEXT_MENU_ROW_HEIGHT = 34;
const MUTATION_GENERATOR_DEVICE_ID = "org.dgw.builtin.mutation-generator";
const GENOME_OPTIMIZER_DEVICE_ID = "org.dgw.builtin.genome-optimizer";
const CONSEQUENCE_DEVICE_ID = "org.dgw.builtin.variant-consequences";

interface ContextMenuItem {
  id: string;
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  hint?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
  invoker?: HTMLElement;
}

type OpenContextMenu = (menu: ContextMenuState) => void;

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
  stackIndex?: number;
  stackCount?: number;
}

export interface OptimizerObjective {
  id: string;
  label: string;
  description: string;
  includedWeightIds: string[];
}

export interface OptimizerWeightControl {
  id: string;
  label: string;
  description?: string;
  sourceDeviceId?: string;
  sourceLabel?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface GenomeOptimizerSettings {
  mode: "conservative" | "saturation";
  objectiveId: string;
  direction: OptimizerDirection;
  weights: Record<string, number>;
  maxEdits: number;
  maximumPositions: number;
}

export interface GenomeOptimizerResult {
  generatedEdits: number;
  changedPositions?: number;
  consideredPositions?: number;
  evaluatedCandidates?: number;
  excludedPositions?: number;
  improvingPositions?: number;
  unchangedOrTiedPositions?: number;
  deferredByChangeLimit?: number;
  beforeScore?: number;
  afterScore?: number;
  scoreUnit?: string;
  summary?: string;
  candidateComparisons?: Array<{
    contig?: string;
    position: number;
    reference: string;
    alternate: string;
    current: boolean;
    selected: boolean;
    comparable: boolean;
    impact?: string;
    score: number;
    exactEvidenceSources: string[];
    note?: string;
  }>;
}

export interface GenomeOptimizerDevice {
  id: string;
  name?: string;
  bypassed: boolean;
  status: OptimizerStatus;
  progress?: number;
  settings: GenomeOptimizerSettings;
  result?: GenomeOptimizerResult;
  generatedEditIds?: string[];
  bypassedScoringDeviceIds?: string[];
  appliedScoringDeviceIds?: string[];
  message?: string;
  rackOrder?: number;
  target?: RackDeviceTarget;
  resource?: string;
  version?: string;
  limitation?: string;
}

export interface AlleleRandomizerSettings {
  mode: "randomizer";
  amount: number;
  seed: number;
  maximumPositions: number;
  substitutionPattern: "uniform" | "transitionOnly" | "transversionOnly" | "tiTvMix";
  transitionProbability: number;
}

export interface AlleleRandomizerPreview {
  selectedPositions: number;
  randomizedPositions: number;
  transitionPositions: number;
  transversionPositions: number;
  generatedEdits: number;
  excludedPositions: number;
  changeCount: number;
  changes: Array<{ contig: string; position: number; from: string; to: string; substitutionClass: "transition" | "transversion" }>;
  compoundLayerId?: string;
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

export interface GenomeMorphSettings {
  targetTrackId: string;
  amount: number;
  ordering: MorphOrdering;
  seed: number;
}

export interface GenomeMorphDevice {
  id: string;
  name: string;
  bypassed: boolean;
  status: OptimizerStatus;
  settings: GenomeMorphSettings;
  preview?: TrackMorphPreviewResult;
  generatedEditIds?: string[];
  progress?: number;
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
  scoreInclusion?: "included" | "excluded";
}

export interface TrackMeterItem {
  editId: string;
  label: string;
  contig: string;
  position: number;
  reference: string;
  alternate: string;
  enabled: boolean;
  evaluated: boolean;
  impactDelta?: number;
  mutationCount?: number;
}

export interface TrackMeterModel {
  evaluatedMutations: number;
  activeMutations: number;
  impactDelta?: number;
  higherImpactMutations?: number;
  lowerImpactMutations?: number;
  unchangedImpactMutations?: number;
  deviceCoverage: Array<{ id: string; label: string; evaluated: number; total: number; exactMatches: number; unavailable: number; errors: number; noTranscriptFeature: number; bypassed: boolean }>;
  items: TrackMeterItem[];
  appliedRun?: {
    device: string;
    mode: string;
    direction: OptimizerDirection;
    active: boolean;
    consideredPositions: number;
    evaluatedCandidates: number;
    generatedEdits: number;
    changedPositions: number;
    activeEdits: number;
    beforeScore?: number;
    afterScore?: number;
    scoreUnit?: string;
  };
}

export interface TrackProfilerModel {
  status: "idle" | "running" | "complete" | "partial";
  profileInputFingerprint?: string;
  progress?: number;
  processedMutations: number;
  totalMutations: number;
  activeAnalyzers: number;
  activeDeviceIds?: string[];
  message: string;
}

export interface GenomeTrackModel {
  id: string;
  name: string;
  kind: GenomeTrackKind;
  visible: boolean;
  edits: GenomeTrackEditBlock[];
  alleles: GenomeTrackAlleleMark[];
  sourceVariantTotal?: number;
  densityMode?: boolean;
  totalEditCount?: number;
  randomizer?: AlleleRandomizerDevice;
  morph?: GenomeMorphDevice;
  optimizer?: GenomeOptimizerDevice;
}

export interface TrackDeviceWorkspaceProps {
  region: FocusContext;
  tracks: GenomeTrackModel[];
  selectedTrackId: string;
  selectedEditId?: string;
  selectedAlleleId?: string;
  selectedAlleleIds?: string[];
  selectedAlleleCount?: number;
  interactiveAlleleLimit?: number;
  allAllelesSelected?: boolean;
  objectives: OptimizerObjective[];
  weightControls: OptimizerWeightControl[];
  rackDevices?: RackDeviceView[];
  appliedDeviceIds?: string[];
  variantDensity?: VariantDensity;
  trackMeter?: TrackMeterModel;
  trackProfiler?: TrackProfilerModel;
  showDeviceRack?: boolean;
  showTrackMeter?: boolean;
  deviceBrowserRequest?: number;
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
  onSelectAllele: (trackId: string, alleleId: string, additive: boolean) => void;
  onMarqueeSelectAlleles?: (trackId: string, alleleIds: string[], additive: boolean) => void;
  onSelectVisibleAlleles?: (trackId: string) => void;
  onSelectAllAlleles?: (trackId: string) => void;
  onClearAlleleSelection?: () => void;
  onShowDeviceRack?: () => void;
  onUndoAction?: () => void;
  onRedoAction?: () => void;
  onToggleEdit: (trackId: string, editId: string, enabled: boolean) => void;
  onOptimizerChange: (trackId: string, settings: GenomeOptimizerSettings) => void;
  onOptimizerBypass: (trackId: string, bypassed: boolean) => void;
  onRegenerate: (trackId: string) => void;
  onConsolidate: (trackId: string) => void;
  onRandomizerChange?: (trackId: string, settings: AlleleRandomizerSettings) => void;
  onRandomizerPreview?: (trackId: string) => void;
  onRandomizerApply?: (trackId: string) => void;
  onRandomizerBypass?: (trackId: string, bypassed: boolean) => void;
  onMorphChange?: (trackId: string, settings: GenomeMorphSettings) => void;
  onMorphPreview?: (trackId: string) => void;
  onMorphApply?: (trackId: string) => void;
  onMorphBypass?: (trackId: string, bypassed: boolean) => void;
  onSelectDevice?: (trackId: string, deviceId: string) => void;
  onToggleDevice?: (trackId: string, deviceId: string, bypassed: boolean) => void;
  onRunDevice?: (trackId: string, deviceId: string) => void;
  onAddDevice?: (trackId: string, deviceId: string) => void;
  onRemoveDevice?: (trackId: string, deviceId: string) => void;
  onResetDevice?: (trackId: string, deviceId: string) => void;
  onAnalyzeTrack?: (trackId: string) => void;
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

function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const height = menu.items.length * CONTEXT_MENU_ROW_HEIGHT + 16;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - CONTEXT_MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8));

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
    function dismissOnPointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }
    function dismissOnWindowChange() {
      onClose();
    }
    document.addEventListener("pointerdown", dismissOnPointer, true);
    window.addEventListener("blur", dismissOnWindowChange);
    window.addEventListener("resize", dismissOnWindowChange);
    window.addEventListener("scroll", dismissOnWindowChange, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointer, true);
      window.removeEventListener("blur", dismissOnWindowChange);
      window.removeEventListener("resize", dismissOnWindowChange);
      window.removeEventListener("scroll", dismissOnWindowChange, true);
    };
  }, [onClose]);

  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowDown"
          ? (current + 1 + buttons.length) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return createPortal(
    <div
      ref={menuRef}
      className="dgw-context-menu"
      role="menu"
      aria-label={menu.label}
      style={{ left, top }}
      onKeyDown={moveFocus}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item) => <button
        type="button"
        role="menuitem"
        className={`${item.danger ? "is-danger" : ""}${item.separatorBefore ? " has-separator" : ""}`}
        disabled={item.disabled}
        onClick={() => {
          onClose();
          item.action();
        }}
        key={item.id}
      >
        <span>{item.label}</span>
        {item.hint && <small>{item.hint}</small>}
      </button>)}
    </div>,
    document.body
  );
}

function TrackRail({
  track,
  region,
  density,
  selected,
  selectedEditId,
  selectedAlleleId,
  selectedAlleleIds = [],
  busy,
  canDelete,
  minimized,
  onSelect,
  onDuplicate,
  onRename,
  onDelete,
  onToggleVisibility,
  onSelectEdit,
  onSelectAllele,
  onMarqueeSelectAlleles,
  onToggleEdit,
  onToggleMinimized,
  onAnalyze,
  onFocusPosition,
  onFocusRange,
  onSelectDevice,
  onOpenContextMenu
}: {
  track: GenomeTrackModel;
  region: FocusContext;
  density?: VariantDensity;
  selected: boolean;
  selectedEditId?: string;
  selectedAlleleId?: string;
  selectedAlleleIds?: string[];
  busy: boolean;
  canDelete: boolean;
  minimized: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onToggleVisibility: (visible: boolean) => void;
  onSelectEdit: (editId: string) => void;
  onSelectAllele: (alleleId: string, additive: boolean) => void;
  onMarqueeSelectAlleles?: (alleleIds: string[], additive: boolean) => void;
  onToggleEdit: (editId: string, enabled: boolean) => void;
  onToggleMinimized: () => void;
  onAnalyze?: () => void;
  onFocusPosition: (position: number) => void;
  onFocusRange: (start: number, end: number) => void;
  onSelectDevice?: (deviceId: string) => void;
  onOpenContextMenu: OpenContextMenu;
}) {
  const isSource = track.kind === "source";
  const [draftName, setDraftName] = useState(track.name);
  const [marquee, setMarquee] = useState<{ pointerId: number; start: number; current: number; additive: boolean }>();
  const suppressAlleleClick = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const showBaseGrid = viewportSpan(region) <= 240;
  const compactAlleles = viewportSpan(region) > 2_000;
  const densityMode = Boolean(track.densityMode && density && density.context.contig === region.contig);
  const densityMaximum = Math.max(1, ...(density?.bins.map((bin) => bin.count) ?? []));

  useEffect(() => setDraftName(track.name), [track.name]);

  function commitName() {
    const normalized = draftName.trim();
    if (!normalized) {
      setDraftName(track.name);
      return;
    }
    if (normalized !== track.name) onRename(normalized);
  }

  function laneOffset(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return clamp(event.clientX - bounds.left, 0, bounds.width);
  }

  function beginMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (densityMode || !selected || !onMarqueeSelectAlleles || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea, .dgw-edit-anchor")) return;
    // Marquee selection starts on empty lane space only. Capturing the pointer
    // from an allele button prevents its ordinary single-click from reaching
    // the button in some WebKit/VM combinations.
    if (target.closest("button")) return;
    const start = laneOffset(event);
    suppressAlleleClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarquee({
      pointerId: event.pointerId,
      start,
      current: start,
      additive: event.ctrlKey || event.metaKey
    });
  }

  function moveMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    const current = laneOffset(event);
    if (Math.abs(current - marquee.start) >= 4) suppressAlleleClick.current = true;
    setMarquee({ ...marquee, current });
  }

  function finishMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    const finish = laneOffset(event);
    const start = Math.min(marquee.start, finish);
    const end = Math.max(marquee.start, finish);
    suppressAlleleClick.current = end - start >= 4;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setMarquee(undefined);
    if (end - start < 4) return;
    const ids = track.alleles
      .filter((allele) => {
        const offset = (positionPercent(allele.position, region) / 100) * bounds.width;
        return offset >= start && offset <= end;
      })
      .map((allele) => allele.id);
    onMarqueeSelectAlleles?.(ids, marquee.additive);
  }

  function openPointerMenu(event: ReactMouseEvent<HTMLElement>, label: string, items: ContextMenuItem[]) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof HTMLElement ? event.target : event.currentTarget;
    const invoker = target.closest<HTMLElement>("button, input, [tabindex]") ?? event.currentTarget;
    onOpenContextMenu({
      x: event.clientX,
      y: event.clientY,
      label,
      items,
      invoker
    });
  }

  function openKeyboardMenu(event: ReactKeyboardEvent<HTMLElement>, label: string, items: ContextMenuItem[]) {
    if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof HTMLElement ? event.target : event.currentTarget;
    const invoker = target.closest<HTMLElement>("button, input, [tabindex]") ?? event.currentTarget;
    const bounds = invoker.getBoundingClientRect();
    onOpenContextMenu({
      x: bounds.left + Math.min(24, bounds.width / 2),
      y: bounds.top + Math.min(bounds.height, 28),
      label,
      items,
      invoker
    });
  }

  function beginRename() {
    onSelect();
    window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
  }

  function trackMenuItems(): ContextMenuItem[] {
    return [
      { id: "select", label: "Select track", action: onSelect, disabled: busy || selected },
      { id: "rename", label: "Rename…", action: beginRename, disabled: busy || isSource },
      { id: "duplicate", label: "Duplicate track", action: onDuplicate, disabled: busy },
      { id: "minimize", label: minimized ? "Expand track" : "Minimize track", action: onToggleMinimized, disabled: busy },
      { id: "visibility", label: track.visible ? "Hide track" : "Show track", action: () => onToggleVisibility(!track.visible), disabled: busy },
      { id: "profile", label: "Refresh Track Profile", action: () => onAnalyze?.(), disabled: busy || !onAnalyze || track.totalEditCount === 0, separatorBefore: true },
      ...(!isSource ? [{ id: "archive", label: "Archive track…", action: onDelete, disabled: busy || !canDelete, danger: true, separatorBefore: true }] : [])
    ];
  }

  function alleleMenuItems(allele: GenomeTrackAlleleMark): ContextMenuItem[] {
    const isOnlySelection = selectedAlleleIds.length === 1 && selectedAlleleIds[0] === allele.id;
    const items: ContextMenuItem[] = [
      { id: "open", label: isSource ? "Inspect in Allele Roll" : "Edit in Allele Roll…", action: () => onSelectAllele(allele.id, false), disabled: busy },
      { id: "focus", label: "Focus on allele", action: () => onFocusPosition(allele.position), disabled: busy },
      { id: "select-only", label: "Select only this allele", action: () => onSelectAllele(allele.id, false), disabled: busy || isOnlySelection, separatorBefore: true },
      { id: "remove-selection", label: "Remove from selection", action: () => onSelectAllele(allele.id, true), disabled: busy }
    ];
    if (!isSource) {
      items.push(
        { id: "mutation-generator", label: "Open selection in Mutation Generator", action: () => onSelectDevice?.(MUTATION_GENERATOR_DEVICE_ID), disabled: busy || !onSelectDevice, separatorBefore: true },
        { id: "genome-optimizer", label: "Open selection in Genome Optimizer", action: () => onSelectDevice?.(GENOME_OPTIMIZER_DEVICE_ID), disabled: busy || !onSelectDevice }
      );
    }
    return items;
  }

  function editMenuItems(edit: GenomeTrackEditBlock): ContextMenuItem[] {
    const matchingAllele = track.alleles.find((allele) => allele.position === edit.position && allele.alternate === edit.alternate);
    return [
      { id: "open", label: "Open mutation", action: () => onSelectEdit(edit.id), disabled: busy },
      { id: "focus", label: "Focus on position", action: () => onFocusPosition(edit.position), disabled: busy },
      { id: "reveal", label: "Reveal effective allele", action: () => matchingAllele && onSelectAllele(matchingAllele.id, false), disabled: busy || !matchingAllele },
      { id: "power", label: edit.enabled ? "Bypass mutation" : "Enable mutation", action: () => onToggleEdit(edit.id, !edit.enabled), disabled: busy, separatorBefore: true },
      { id: "profile", label: "Refresh Track Profile", action: () => onAnalyze?.(), disabled: busy || !onAnalyze }
    ];
  }

  return (
    <article className={`dgw-track ${isSource ? "is-source" : "is-candidate"}${selected ? " is-selected" : ""}${track.visible ? "" : " is-hidden"}${minimized ? " is-minimized" : ""}`}>
      <div
        className="dgw-track-controls"
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("input")) return;
          if (!selected) onSelect();
          openPointerMenu(event, `${track.name} actions`, trackMenuItems());
        }}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest("input")) return;
          openKeyboardMenu(event, `${track.name} actions`, trackMenuItems());
        }}
      >
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
            ref={nameInputRef}
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
          <button
            type="button"
            className="dgw-track-fold"
            onClick={onToggleMinimized}
            disabled={busy}
            aria-label={`${minimized ? "Expand" : "Minimize"} ${track.name}`}
            aria-pressed={minimized}
            title={minimized ? "Expand track" : "Minimize track"}
          >{minimized ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}</button>
          <button type="button" onClick={onDuplicate} disabled={busy} title="Duplicate track" aria-label="Duplicate track"><Copy aria-hidden="true" /></button>
          <button
            type="button"
            className={track.visible ? "is-on" : ""}
            aria-pressed={track.visible}
            aria-label={track.visible ? "Hide track" : "Show track"}
            title={track.visible ? "Hide track" : "Show track"}
            onClick={() => onToggleVisibility(!track.visible)}
            disabled={busy}
          >
            {track.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          </button>
          {!isSource && <button
            type="button"
            className="danger"
            onClick={onDelete}
            disabled={busy || !canDelete}
            title="Archive track"
            aria-label="Archive track"
          ><Trash2 aria-hidden="true" /></button>}
        </div>
      </div>

      <div
        className={`dgw-track-lane${showBaseGrid ? " is-base-scale" : ""}${compactAlleles ? " is-allele-compact" : ""}${selected && onMarqueeSelectAlleles ? " is-marquee-enabled" : ""}`}
        aria-label={`${track.name} edits in the focused region`}
        style={{ "--dgw-base-width": `${100 / viewportSpan(region)}%` } as CSSProperties}
        onPointerDown={beginMarquee}
        onPointerMove={moveMarquee}
        onPointerUp={finishMarquee}
        onPointerCancel={() => setMarquee(undefined)}
      >
        {marquee && <div
          className="dgw-selection-marquee"
          style={{ left: `${Math.min(marquee.start, marquee.current)}px`, width: `${Math.abs(marquee.current - marquee.start)}px` }}
          aria-hidden="true"
        />}
        <div className="dgw-lane-grid" aria-hidden="true">
          {showBaseGrid && Array.from({ length: viewportSpan(region) }, (_, index) => region.start + index).map((position) => (
            <i className="base" key={`base-${position}`} style={{ left: `${positionPercent(position, region)}%` }} />
          ))}
          {viewportTicks(region).map((position) => (
            <i className="major" key={position} style={{ left: `${positionPercent(position, region)}%` }} />
          ))}
        </div>
        <div className="dgw-track-baseline" />
        {densityMode && density && <div className="dgw-track-density" aria-label={`${track.sourceVariantTotal?.toLocaleString() ?? density.total.toLocaleString()} source ALT alleles in density view`}>
          {density.bins.map((bin, index) => {
            const height = bin.count === 0 ? 2 : 5 + 58 * Math.log1p(bin.count) / Math.log1p(densityMaximum);
            return <button
              type="button"
              style={{ height: `${height}%` }}
              disabled={busy || bin.count === 0}
              title={bin.count === 0
                ? `${region.contig}:${bin.start.toLocaleString()}–${bin.end.toLocaleString()} · no source ALTs`
                : `${region.contig}:${bin.start.toLocaleString()}–${bin.end.toLocaleString()} · ${bin.count.toLocaleString()} source ${bin.count === 1 ? "ALT" : "ALTs"} · click to zoom`}
              aria-label={`Zoom to ${region.contig}:${bin.start}-${bin.end}, ${bin.count} source ALTs`}
              onClick={() => onFocusRange(bin.start, bin.end)}
              key={`${bin.start}-${index}`}
            />;
          })}
          <span>{(track.sourceVariantTotal ?? density.total).toLocaleString()} source ALTs · density view · click a peak to zoom</span>
        </div>}
        {(track.alleles ?? []).map((allele) => (
          <button
            type="button"
            className={`dgw-allele-mark ${allele.origin}${selected && (selectedAlleleIds?.includes(allele.id) || allele.id === selectedAlleleId) ? " is-selected" : ""}`}
            key={allele.id}
            style={{
              left: `${positionPercent(allele.position, region)}%`,
              "--dgw-allele-stack-offset": `${((allele.stackIndex ?? 0) - ((allele.stackCount ?? 1) - 1) / 2) * 18}px`
            } as CSSProperties}
            title={`${isSource ? "Inspect protected source allele" : "Edit candidate allele"} · ${region.contig}:${allele.position.toLocaleString()} ${allele.reference}→${allele.alternate} · Control/Command-click to add or remove from selection`}
            aria-label={`${isSource ? "Inspect source" : "Edit candidate"} allele ${region.contig}:${allele.position} ${allele.reference} to ${allele.alternate}`}
            onClick={(event) => {
              if (suppressAlleleClick.current) {
                suppressAlleleClick.current = false;
                return;
              }
              onSelectAllele(allele.id, event.metaKey || event.ctrlKey);
            }}
            onContextMenu={(event) => {
              suppressAlleleClick.current = true;
              window.setTimeout(() => { suppressAlleleClick.current = false; }, 250);
              if (!selected || !selectedAlleleIds.includes(allele.id)) onSelectAllele(allele.id, false);
              openPointerMenu(event, `${region.contig}:${allele.position} allele actions`, alleleMenuItems(allele));
            }}
            onKeyDown={(event) => openKeyboardMenu(event, `${region.contig}:${allele.position} allele actions`, alleleMenuItems(allele))}
            disabled={busy && !selected}
          >
            <span className="dgw-allele-stem" />
            <span className="dgw-allele-head" />
            <span className="dgw-allele-label"><small>{isSource ? "SRC" : "EDIT"}</small>{compactAllele(allele.reference, allele.alternate)}</span>
          </button>
        ))}
        {isSource && !densityMode && (track.alleles?.length ?? 0) === 0 && <span className="dgw-track-origin">No alternate alleles in view</span>}
        {track.edits.map((edit) => {
          const left = positionPercent(edit.position, region);
          const isEditSelected = edit.id === selectedEditId;
          const title = `${region.contig}:${edit.position.toLocaleString()} ${edit.reference}→${edit.alternate} · ${copyLabel(edit.copy)}${edit.consequence ? ` · ${edit.consequence}` : ""}`;
          return (
            <div
              className={`dgw-edit-anchor${edit.enabled ? "" : " is-bypassed"}${isEditSelected ? " is-selected" : ""}`}
              style={{ left: `${left}%` }}
              key={edit.id}
              onContextMenu={(event) => {
                if (!selected || !isEditSelected) onSelectEdit(edit.id);
                openPointerMenu(event, `${region.contig}:${edit.position} mutation actions`, editMenuItems(edit));
              }}
              onKeyDown={(event) => openKeyboardMenu(event, `${region.contig}:${edit.position} mutation actions`, editMenuItems(edit))}
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
  const drag = useRef<{ pointerId: number; startY: number; startValue: number } | null>(null);
  const progress = (clamp(value, min, max) - min) / Math.max(1, max - min);
  const angle = -135 + progress * 270;
  const style = { "--dgw-knob-angle": `${angle}deg` } as CSSProperties;

  function setSteppedValue(next: number) {
    const precision = Math.max(0, (String(step).split(".")[1] ?? "").length);
    const stepped = min + Math.round((next - min) / step) * step;
    onChange(Number(clamp(stepped, min, max).toFixed(precision)));
  }

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startValue: value };
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = ((active.startY - event.clientY) / 120) * (max - min);
    setSteppedValue(active.startValue + delta);
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  }

  return (
    <div className="dgw-number-knob">
      <button
        type="button"
        className="dgw-knob-face"
        style={style}
        role="slider"
        aria-label={`${label}: ${value}. Drag up or down, or use the mouse wheel.`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={(event) => {
          if (disabled) return;
          event.preventDefault();
          event.stopPropagation();
          setSteppedValue(value + (event.deltaY < 0 ? step : -step));
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowRight") {
            event.preventDefault();
            setSteppedValue(value + step);
          } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
            event.preventDefault();
            setSteppedValue(value - step);
          } else if (event.key === "Home") {
            event.preventDefault();
            setSteppedValue(min);
          } else if (event.key === "End") {
            event.preventDefault();
            setSteppedValue(max);
          }
        }}
        disabled={disabled}
      ><i /></button>
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
    </div>
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
    stale: "Pending run",
    error: "Error",
    complete: "Complete",
    found: "Match found",
    noExactMatch: "No exact match",
    notComputed: "Not run",
    resourceUnavailable: "Unavailable"
  };
  return labels[status];
}

function deviceLightState(status: RackDeviceStatus, bypassed = false) {
  if (bypassed) return "bypassed";
  if (status === "running" || status === "error" || status === "resourceUnavailable") return status;
  return "active";
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
      className={`dgw-rack-device-card kind-${device.kind}${selected ? " is-selected" : ""}${device.bypassed ? " is-bypassed" : ""}`}
      aria-label={`${device.name} device`}
    >
      <header className="dgw-compact-device-header">
        <button type="button" className="dgw-device-identity" onClick={onSelect} disabled={!onSelect || busy}>
          <span className={`dgw-device-light ${deviceLightState(device.status, device.bypassed)}`} aria-hidden="true" />
          <span>
            <small>{device.kind === "visualization" ? "visualize" : "evidence"}</small>
            <b>{device.name}</b>
          </span>
        </button>
        <button
          type="button"
          className={`dgw-bypass ${device.bypassed ? "is-active" : ""}`}
          aria-pressed={!device.bypassed}
          aria-label={`${device.name} is ${device.bypassed ? "bypassed" : "active"}. Toggle device.`}
          onClick={() => onToggle?.(!device.bypassed)}
          title={device.bypassed ? "Enable device" : "Bypass device"}
          disabled={!onToggle || disabled}
        >
          <Power aria-hidden="true" /><span className="dgw-visually-hidden">{device.bypassed ? "Bypassed" : "Active"}</span>
        </button>
      </header>

      <div className="dgw-device-status-line" aria-label="Device status">
        <span className={`dgw-rack-status ${device.status}`}>{rackStatusLabel(device.status)}</span>
        {device.scoreInclusion && <span className={`dgw-score-membership ${device.scoreInclusion}${device.bypassed ? " is-bypassed" : ""}`}>
          {device.scoreInclusion === "excluded"
            ? "Not in objective"
            : device.bypassed
              ? "Included · effective 0"
              : "Included"}
        </span>}
      </div>

      <div className="dgw-compact-result" aria-live="polite">
        <b>{running ? "Running…" : device.result ?? "No result yet"}</b>
      </div>

      <footer className="dgw-compact-device-actions single">
        <button
          type="button"
          className="primary"
          onClick={onRun}
          disabled={!onRun || disabled || device.bypassed || device.canRun === false}
        >
          {running ? "Running…" : device.runLabel ?? "Run"}
        </button>
      </footer>
      <details className="dgw-device-details">
        <summary>Details</summary>
        <dl className="dgw-device-metadata">
          <div><dt>Target</dt><dd>{rackTargetLabel(device.target)}</dd></div>
          <div><dt>Resource</dt><dd title={resource}>{resource}</dd></div>
        </dl>
        <p className="dgw-device-limitation"><b>Limit</b>{device.limitation ?? "Interpret this result only within the stated target."}</p>
      </details>
    </section>
  );
}

function OptimizerDeviceCard({
  track,
  device,
  objectives,
  weightControls,
  selectedCount,
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
  selectedCount: number;
  selected: boolean;
  busy: boolean;
  onSelect?: () => void;
  onChange: (settings: GenomeOptimizerSettings) => void;
  onBypass: (bypassed: boolean) => void;
  onRegenerate: () => void;
  onConsolidate: () => void;
}) {
  const settings = device.settings;
  const saturation = settings.mode === "saturation";
  const disabled = busy || device.status === "running";
  const maximumPositions = Math.max(1, Math.min(100_000, Math.trunc(settings.maximumPositions || 1_000)));
  const maximumChanges = saturation
    ? Math.max(1, Math.min(100_000, selectedCount))
    : Math.max(1, Math.min(100_000, selectedCount || maximumPositions));
  const objective = objectives.find((item) => item.id === (saturation ? "predictedImpactBurden" : settings.objectiveId));
  const usesAnnotationWeights = Boolean(objective?.includedWeightIds.length);
  const bypassedScoringDeviceIds = new Set(device.bypassedScoringDeviceIds ?? []);
  const appliedScoringDeviceIds = new Set(device.appliedScoringDeviceIds ?? []);
  const inputStateFor = (control: OptimizerWeightControl) => saturation && control.id !== "impact"
    ? "excluded" as const
    : scoringInputState(objective, control, bypassedScoringDeviceIds, appliedScoringDeviceIds);
  const effectiveWeightTotal = weightControls.reduce((total, control) => (
    inputStateFor(control) === "included"
      ? total + (settings.weights[control.id] ?? 0)
      : total
  ), 0);
  const hasNoEffectiveWeight = usesAnnotationWeights && effectiveWeightTotal <= 0;
  const consequenceDeviceId = CONSEQUENCE_DEVICE_ID;
  const hasActiveConsequences = appliedScoringDeviceIds.has(consequenceDeviceId)
    && !bypassedScoringDeviceIds.has(consequenceDeviceId);
  const hasActiveClinvar = [...appliedScoringDeviceIds].some((id) => id.includes("clinvar"))
    && ![...bypassedScoringDeviceIds].some((id) => id.includes("clinvar"));
  const selectionOverLimit = selectedCount > maximumPositions;
  const saturationBlocked = saturation && (selectedCount === 0 || selectionOverLimit || !hasActiveConsequences || !hasActiveClinvar);
  const hasGeneratedChanges = (device.result?.generatedEdits ?? 0) > 0;
  const update = (patch: Partial<GenomeOptimizerSettings>) => onChange({ ...settings, ...patch });
  const resource = [device.resource, device.version].filter(Boolean).join(" · ") || "Configured evidence devices";

  return (
    <section className={`dgw-optimizer${selected ? " is-selected" : ""}${device.bypassed ? " is-bypassed" : ""}`} aria-label={device.name ?? "Genome Optimizer"} data-context-help="genome-optimizer">
      <header className="dgw-device-header">
        <button type="button" className="dgw-device-identity" onClick={onSelect} disabled={!onSelect || busy}>
          <span className={`dgw-device-light ${deviceLightState(device.status, device.bypassed)}`} aria-hidden="true" />
          <span><small>analyze</small><b>{device.name ?? "Genome Optimizer"}</b></span>
        </button>
        <button
          type="button"
          className={`dgw-bypass ${device.bypassed ? "is-active" : ""}`}
          aria-pressed={!device.bypassed}
          aria-label={`${device.name ?? "Genome Optimizer"} is ${device.bypassed ? "bypassed" : "active"}. Toggle device.`}
          onClick={() => onBypass(!device.bypassed)}
          title={device.bypassed ? "Enable device" : "Bypass device"}
          disabled={disabled}
        >
          <Power aria-hidden="true" /><span className="dgw-visually-hidden">{device.bypassed ? "Bypassed" : "Active"}</span>
        </button>
      </header>

      <div className="dgw-device-status-line" aria-label="Optimizer scope and status">
        <span>{saturation
          ? `${selectedCount} selected ${selectedCount === 1 ? "position" : "positions"}`
          : rackTargetLabel(device.target ?? "focusedRegion")}</span>
        <span className={`dgw-rack-status ${device.status}`}>{rackStatusLabel(device.status)}</span>
      </div>

      <div className="dgw-device-objective">
        <label>
          Mode
          <select
            value={settings.mode}
            onChange={(event) => {
              const mode = event.currentTarget.value as GenomeOptimizerSettings["mode"];
              update({
                mode,
                objectiveId: mode === "saturation"
                  ? "predictedImpactBurden"
                  : "alternateAlleleBurden"
              });
            }}
            disabled={disabled}
          >
            <option value="saturation">Saturation scan</option>
            <option value="conservative">Conservative</option>
          </select>
        </label>
        <label>
          Objective
          <select
            value={saturation ? "predictedImpactBurden" : settings.objectiveId}
            onChange={(event) => update({ objectiveId: event.target.value })}
            disabled
          >
            {objectives
              .filter((item) => item.id === (saturation ? "predictedImpactBurden" : "alternateAlleleBurden"))
              .map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
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
      </div>

      <div className={`dgw-fader-bank${usesAnnotationWeights ? "" : " is-inactive"}`} aria-label="Scoring weights">
        {weightControls.map((control) => {
          const min = control.min ?? 0;
          const max = control.max ?? 100;
          const step = control.step ?? 5;
          const value = clamp(settings.weights[control.id] ?? min, min, max);
          const inputState = inputStateFor(control);
          const effectiveValue = inputState === "included" ? value : 0;
          return (
            <label className={`dgw-fader is-${inputState}`} key={control.id} title={control.description}>
              <output title={`Configured weight ${value}`}>{value}</output>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                aria-label={`${control.label} configured scoring weight ${value}; ${inputState === "excluded" ? "not in objective" : inputState === "notApplied" ? "required device is not applied to this track, effective weight zero" : inputState === "bypassed" ? "device bypassed, effective weight zero" : `effective weight ${effectiveValue}`}`}
                onChange={(event) => update({
                  weights: { ...settings.weights, [control.id]: Number(event.target.value) }
                })}
                disabled={disabled || inputState === "excluded"}
              />
              <span>{control.label}</span>
              <small className="dgw-fader-state">{inputState === "excluded"
                ? saturation ? "Not used in Saturation" : "Not in score"
                : inputState === "notApplied"
                  ? `${control.sourceLabel ?? "Device"} not in rack → 0`
                : inputState === "bypassed"
                  ? `${control.sourceLabel ?? "Device"} bypassed → 0`
                  : `${control.sourceLabel ? `${control.sourceLabel} · ` : ""}Effective ${effectiveValue}`}</small>
            </label>
          );
        })}
      </div>
      <div className="dgw-knob-bank single">
        <NumberKnob
          label={saturation ? "Maximum changes" : "Maximum edits"}
          value={Math.min(settings.maxEdits, maximumChanges)}
          min={1}
          max={maximumChanges}
          step={1}
          disabled={disabled}
          onChange={(maxEdits) => update({ maxEdits })}
        />
      </div>

      <label className="dgw-optimizer-run-limit">
        <span>Maximum positions per run <output>{maximumPositions.toLocaleString()}</output></span>
        <input
          type="number"
          min={1}
          max={100000}
          step={1000}
          value={maximumPositions}
          onChange={(event) => update({ maximumPositions: Math.max(1, Math.min(100_000, Math.trunc(Number(event.currentTarget.value) || 1))) })}
          disabled={disabled}
        />
      </label>

      <div className="dgw-device-result" aria-live="polite">
        <span>{device.status === "running"
          ? <span className="dgw-device-running"><i aria-hidden="true" /><b>{device.progress === undefined ? "Working" : `${device.progress}%`}</b>{device.message ?? "Genome Optimizer is running in the background…"}</span>
          : selectionOverLimit
            ? `${selectedCount.toLocaleString()} positions are selected across the track. Raise Maximum positions to run the complete scope, or narrow the selection.`
            : device.message ?? "Ready to generate candidates"}</span>
        {device.result && (
          <div>
            {device.result.generatedEdits === 0 && <p className="dgw-optimizer-no-op">
              <b>No mutation layer created</b>
              <span>{device.message ?? "The current alleles already satisfy the selected objective."} Nothing needs to be consolidated.</span>
            </p>}
            <b>{settings.mode === "saturation"
              ? device.result.generatedEdits === 0
                ? "No positions changed"
                : `${device.result.changedPositions ?? device.result.generatedEdits} ${(device.result.changedPositions ?? device.result.generatedEdits) === 1 ? "position" : "positions"} changed · ${device.result.generatedEdits} mutation ${device.result.generatedEdits === 1 ? "block" : "blocks"}`
              : `${device.result.generatedEdits} discrete edits`}</b>
            {device.result.beforeScore !== undefined && device.result.afterScore !== undefined && (
              <small>
                {device.result.beforeScore.toLocaleString()} → {device.result.afterScore.toLocaleString()} {device.result.scoreUnit}
              </small>
            )}
            {device.result.summary && <small>{device.result.summary}</small>}
            {settings.mode === "saturation" && device.result.consideredPositions !== undefined && <div className="dgw-optimizer-audit" aria-label="Saturation run accounting">
              <b>Saturation audit</b>
              <span><strong>{device.result.consideredPositions.toLocaleString()}</strong> selected positions</span>
              <span><strong>{(device.result.evaluatedCandidates ?? 0).toLocaleString()}</strong> candidate ALTs evaluated</span>
              <span><strong>{(device.result.unchangedOrTiedPositions ?? 0).toLocaleString()}</strong> current ALT already best or tied</span>
              <span><strong>{(device.result.excludedPositions ?? 0).toLocaleString()}</strong> excluded positions</span>
              <span><strong>{(device.result.improvingPositions ?? device.result.changedPositions ?? 0).toLocaleString()}</strong> strictly improving positions</span>
              <span className="is-applied"><strong>{(device.result.changedPositions ?? 0).toLocaleString()}</strong> positions changed</span>
              {(device.result.deferredByChangeLimit ?? 0) > 0 && <small>{device.result.deferredByChangeLimit?.toLocaleString()} improving positions were not applied because of Maximum changes.</small>}
            </div>}
            {device.result.candidateComparisons && device.result.candidateComparisons.length > 0 && <details className="dgw-saturation-comparisons">
              <summary>Candidate comparison · {device.result.candidateComparisons.length} alleles</summary>
              <table>
                <thead><tr><th>Locus</th><th>ALT</th><th>Impact</th><th>Score</th><th>Evidence</th></tr></thead>
                <tbody>{device.result.candidateComparisons.map((candidate) => <tr
                  className={`${candidate.selected ? "is-winner" : ""}${candidate.comparable ? "" : " is-incomparable"}`}
                  key={`${candidate.contig}-${candidate.position}-${candidate.alternate}`}
                  title={candidate.note}
                >
                  <td>{candidate.contig ? `${candidate.contig}:` : ""}{candidate.position.toLocaleString()}</td>
                  <td><b>{candidate.alternate}</b>{candidate.current && <small>current</small>}{candidate.selected && <small>winner</small>}</td>
                  <td>{candidate.impact ?? "—"}</td>
                  <td>{candidate.comparable ? candidate.score.toLocaleString() : "—"}</td>
                  <td>{candidate.exactEvidenceSources.length > 0 ? candidate.exactEvidenceSources.join(", ") : "No exact database match"}</td>
                </tr>)}</tbody>
              </table>
            </details>}
          </div>
        )}
      </div>

      <footer className="dgw-device-actions">
        <button type="button" className={hasGeneratedChanges ? undefined : "primary"} onClick={onRegenerate} disabled={disabled || device.bypassed || hasNoEffectiveWeight || selectionOverLimit || saturationBlocked} title={selectionOverLimit
          ? `Raise Maximum positions to at least ${selectedCount.toLocaleString()}, or narrow the selection`
          : saturationBlocked
          ? selectedCount === 0 ? "Select at least one SNV position" : "Apply and enable Variant Consequences and ClinVar first"
          : undefined}>
          {device.status === "running" ? "Generating…" : saturation ? "Run saturation" : device.result ? "Regenerate" : "Generate edits"}
        </button>
        <button
          type="button"
          className={hasGeneratedChanges ? "primary" : undefined}
          onClick={onConsolidate}
          disabled={disabled || device.bypassed || (track.totalEditCount ?? track.edits.length) === 0}
          title={(track.totalEditCount ?? track.edits.length) === 0
            ? "This track has no mutation blocks to consolidate"
            : "Materialize enabled edits into a new track baseline"}
        >
          Consolidate
        </button>
      </footer>
      <details className="dgw-device-details">
        <summary>Model details</summary>
        <div className="dgw-device-details-copy">
          <p>{objective?.description ?? "Choose a named score before generating candidate edits."}</p>
          <p>{saturation
            ? `${settings.direction === "minimize" ? "Minimize" : "Maximize"} compares all three possible non-reference SNV bases at every selected position and chooses the ${settings.direction === "minimize" ? "lowest" : "highest"} transcript-consequence impact score.`
            : settings.direction === "minimize"
              ? "Minimize removes eligible ALT copies by restoring REF. This minimizes distance from the reference; it does not claim that REF is benign."
              : "Maximize can reintroduce missing source-sample ALT copies; it measures reference distance and does not invent new alleles."}</p>
          {saturation && <p>ClinVar is a fixed Pathogenic/Likely pathogenic exclusion guard. COSMIC remain evidence only. A missing database match never means benign and never lowers the score.</p>}
          <p>{usesAnnotationWeights
            ? hasNoEffectiveWeight
              ? "No scoring input has a positive effective weight. Add or enable an included device, or raise an included weight."
              : "The objective names its inputs. A bypassed device contributes 0 while its configured weight is retained."
            : "The selected objective counts ALT copies and ignores annotation weights."}</p>
        </div>
        <dl className="dgw-device-metadata">
          <div><dt>Resources</dt><dd title={resource}>{resource}</dd></div>
        </dl>
        <p className="dgw-device-limitation optimizer-limit"><b>Limit</b>{device.limitation ?? "Nearby allele scores remain independent; this device does not infer a combined biological effect."}</p>
        <p className="dgw-consolidate-note">Consolidation moves the entire current effective genome into this track’s visual baseline. Full edit ancestry remains in the audit trail.</p>
      </details>
    </section>
  );
}

function RandomizerDeviceCard({
  device,
  selectedCount,
  interactiveMaterializationLimit,
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
  interactiveMaterializationLimit: number;
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
  const maximumPositions = Math.max(1, Math.min(100_000, Math.trunc(device.settings.maximumPositions || 1_000)));
  const selectionOverLimit = selectedCount > maximumPositions;
  const bulkPreview = selectedCount > interactiveMaterializationLimit;
  const compoundPreview = Boolean(preview?.compoundLayerId);
  const update = (patch: Partial<AlleleRandomizerSettings>) => onChange({ ...device.settings, ...patch });
  return <section className={`dgw-randomizer${selected ? " is-selected" : ""}${device.bypassed ? " is-bypassed" : ""}`} aria-label="Mutation Generator">
    <header className="dgw-device-header">
      <button type="button" className="dgw-device-identity" onClick={onSelect} disabled={!onSelect || busy}>
        <span className={`dgw-device-light ${deviceLightState(device.status, device.bypassed)}`} aria-hidden="true" />
        <span><small>edit</small><b>{device.name}</b></span>
      </button>
      <button type="button" className={`dgw-bypass ${device.bypassed ? "is-active" : ""}`} aria-pressed={!device.bypassed} title={device.bypassed ? "Enable device" : "Bypass device"} onClick={() => onBypass(!device.bypassed)} disabled={disabled}>
        <Power aria-hidden="true" /><span className="dgw-visually-hidden">{device.bypassed ? "Bypassed" : "Active"}</span>
      </button>
    </header>
    <div className="dgw-device-status-line" aria-label="Selected positions and status">
      <span>{selectedCount.toLocaleString()} selected {selectedCount === 1 ? "position" : "positions"}</span>
      <span className={`dgw-rack-status ${device.status}`}>{rackStatusLabel(device.status)}</span>
    </div>
    <div className="dgw-randomizer-controls">
      <label>
        <span>Mode</span>
        <select value={device.settings.mode} onChange={(event) => update({ mode: event.currentTarget.value as AlleleRandomizerSettings["mode"] })} disabled={disabled}>
          <option value="randomizer">Randomizer</option>
        </select>
      </label>
      <label>
        <span>Amount <output>{device.settings.amount}%</output></span>
        <input type="range" min={0} max={100} step={1} value={device.settings.amount} onChange={(event) => update({ amount: Number(event.currentTarget.value) })} disabled={disabled} />
      </label>
      <label>
        <span>Seed</span>
        <input type="number" min={0} step={1} value={device.settings.seed} onChange={(event) => update({ seed: Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0)) })} disabled={disabled} />
      </label>
      <label className="dgw-randomizer-limit">
        <span>Maximum positions <output>{maximumPositions.toLocaleString()}</output></span>
        <input type="number" min={1} max={100000} step={1000} value={maximumPositions} onChange={(event) => update({ maximumPositions: Math.max(1, Math.min(100_000, Math.trunc(Number(event.currentTarget.value) || 1))) })} disabled={disabled} />
      </label>
      <label className="dgw-randomizer-pattern">
        <span>Substitution pattern</span>
        <select value={device.settings.substitutionPattern} onChange={(event) => update({ substitutionPattern: event.currentTarget.value as AlleleRandomizerSettings["substitutionPattern"] })} disabled={disabled}>
          <option value="uniform">Uniform</option>
          <option value="transitionOnly">Transitions only</option>
          <option value="transversionOnly">Transversions only</option>
          <option value="tiTvMix">Ti/Tv mixture</option>
        </select>
      </label>
      {device.settings.substitutionPattern === "tiTvMix" && <label className="dgw-randomizer-mix">
        <span>Transition probability <output>{device.settings.transitionProbability}%</output></span>
        <input type="range" min={0} max={100} step={1} value={device.settings.transitionProbability} onChange={(event) => update({ transitionProbability: Number(event.currentTarget.value) })} disabled={disabled} />
      </label>}
    </div>
    <div className="dgw-randomizer-result" aria-live="polite">
      {device.status === "running" ? <div className="dgw-device-running">
        <i aria-hidden="true" />
        <b>Preparing mutation layer</b>
        <small>{device.message ?? "The background preview is running…"}</small>
      </div> : preview ? <>
        <b>{preview.randomizedPositions.toLocaleString()}/{preview.selectedPositions.toLocaleString()} positions · {preview.generatedEdits.toLocaleString()} {compoundPreview ? "copy-specific changes" : "mutation blocks"}</b>
        {compoundPreview && <small>Background result · ready as one reversible mutation layer</small>}
        <small>{preview.transitionPositions} transitions · {preview.transversionPositions} transversions</small>
        {preview.excludedPositions > 0 && <small>{preview.excludedPositions} unsupported or unavailable positions skipped</small>}
        {preview.message && <small>{preview.message}</small>}
      </> : <span>{selectionOverLimit
        ? `${selectedCount.toLocaleString()} positions are selected. Raise Maximum positions to test the complete scope, or narrow the selection.`
        : bulkPreview
          ? `Bulk scope: ${selectedCount.toLocaleString()} selected positions. Preview prepares one compact mutation layer for this track.`
        : device.message ?? "Select visible alleles, then preview a deterministic randomization."}</span>}
    </div>
    <footer className="dgw-device-actions">
      <button
        type="button"
        onClick={onPreview}
        disabled={disabled || device.bypassed || selectedCount === 0 || selectionOverLimit}
        title={selectionOverLimit ? `Raise Maximum positions to at least ${selectedCount.toLocaleString()}, or narrow the selection` : undefined}
      >{device.status === "running" ? "Preparing…" : "Preview"}</button>
      <button
        type="button"
        className="primary"
        onClick={onApply}
        disabled={disabled || device.bypassed || !preview || preview.generatedEdits === 0 || (bulkPreview && !preview.compoundLayerId)}
        title={compoundPreview ? "Apply every previewed change to the selected track as one reversible layer" : undefined}
      >{compoundPreview ? "Apply mutation layer" : "Apply as blocks"}</button>
    </footer>
    <details className="dgw-device-details">
      <summary>{preview?.changeCount ? `${preview.changeCount.toLocaleString()} changes & details` : "Details"}</summary>
      {preview && <div className="dgw-randomizer-changes">
        {preview.changeCount > 0 && preview.changes.length === 0
          ? <small>Bulk preview: {preview.changeCount.toLocaleString()} planned allele changes are summarized above; individual changes are not rendered.</small>
          : preview.changeCount > preview.changes.length
            ? <small>Showing the first {preview.changes.length.toLocaleString()} of {preview.changeCount.toLocaleString()} planned allele changes.</small>
            : null}
        {preview.changes.map((change) => <code key={`${change.contig}-${change.position}-${change.from}-${change.to}`}>{change.contig}:{change.position.toLocaleString()} {change.from}→{change.to} · {change.substitutionClass}</code>)}
      </div>}
      <dl className="dgw-device-metadata">
        <div><dt>Scope</dt><dd>Canonical SNVs · substitution class relative to REF</dd></div>
      </dl>
      <p className="dgw-device-limitation optimizer-limit"><b>Limit</b>{device.limitation}</p>
    </details>
  </section>;
}

function GenomeMorphDeviceCard({
  track,
  targets,
  device,
  selected,
  busy,
  onSelect,
  onChange,
  onPreview,
  onApply,
  onBypass
}: {
  track: GenomeTrackModel;
  targets: GenomeTrackModel[];
  device: GenomeMorphDevice;
  selected: boolean;
  busy: boolean;
  onSelect?: () => void;
  onChange: (settings: GenomeMorphSettings) => void;
  onPreview: () => void;
  onApply: () => void;
  onBypass: (bypassed: boolean) => void;
}) {
  const disabled = busy || device.status === "running";
  const target = targets.find((candidate) => candidate.id === device.settings.targetTrackId);
  const preview = device.preview;
  const update = (patch: Partial<GenomeMorphSettings>) => onChange({ ...device.settings, ...patch });
  return <section className={`dgw-randomizer dgw-morph${selected ? " is-selected" : ""}${device.bypassed ? " is-bypassed" : ""}`} aria-label="Genome Morph">
    <header className="dgw-device-header">
      <button type="button" className="dgw-device-identity" onClick={onSelect} disabled={!onSelect || busy}>
        <span className={`dgw-device-light ${deviceLightState(device.status, device.bypassed)}`} aria-hidden="true" />
        <span><small>edit</small><b>{device.name}</b></span>
      </button>
      <button type="button" className={`dgw-bypass ${device.bypassed ? "is-active" : ""}`} aria-pressed={!device.bypassed} title={device.bypassed ? "Enable device" : "Bypass device"} onClick={() => onBypass(!device.bypassed)} disabled={disabled}>
        <Power aria-hidden="true" /><span className="dgw-visually-hidden">{device.bypassed ? "Bypassed" : "Active"}</span>
      </button>
    </header>
    <div className="dgw-device-status-line" aria-label="Morph source and status">
      <span title={track.name}>From {track.name}</span>
      <span className={`dgw-rack-status ${device.status}`}>{rackStatusLabel(device.status)}</span>
    </div>
    <div className="dgw-randomizer-controls dgw-morph-controls">
      <label className="dgw-morph-target">
        <span>Target track</span>
        <select value={device.settings.targetTrackId} onChange={(event) => update({ targetTrackId: event.currentTarget.value })} disabled={disabled || targets.length === 0}>
          <option value="">Choose target…</option>
          {targets.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
        </select>
      </label>
      <label className="dgw-morph-amount">
        <span>Morph <output>{device.settings.amount}%</output></span>
        <input type="range" min={0} max={100} step={1} value={device.settings.amount} onChange={(event) => update({ amount: Number(event.currentTarget.value) })} disabled={disabled} />
      </label>
      <label>
        <span>Ordering</span>
        <select value={device.settings.ordering} onChange={(event) => update({ ordering: event.currentTarget.value as MorphOrdering })} disabled={disabled}>
          <option value="genomic">Genomic order</option>
          <option value="seededRandom">Seeded random</option>
        </select>
      </label>
      {device.settings.ordering === "seededRandom" && <label>
        <span>Seed</span>
        <input type="number" min={0} step={1} value={device.settings.seed} onChange={(event) => update({ seed: Math.max(0, Math.trunc(Number(event.currentTarget.value) || 0)) })} disabled={disabled} />
      </label>}
    </div>
    <div className="dgw-morph-result" aria-live="polite">
      {device.status === "running" ? <>
        <div><b>Preparing morph preview</b><strong>{device.progress ?? 0}%</strong></div>
        <span className="dgw-morph-progress"><i style={{ width: `${device.progress ?? 0}%` }} /></span>
        <small>{device.message}</small>
      </> : preview ? <>
        <b>{preview.selectedPositions.toLocaleString()} / {preview.differingPositions.toLocaleString()} differing positions</b>
        <small>{preview.generatedEdits.toLocaleString()} copy-specific changes · {preview.amount}% toward {target?.name ?? "target"}</small>
        {preview.noOpReason && <small>{preview.noOpReason}</small>}
      </> : <span>{targets.length === 0
        ? "Duplicate a track to create a compatible morph target."
        : device.message ?? "Choose another project track and preview a discrete intermediate state."}</span>}
    </div>
    <footer className="dgw-device-actions">
      <button type="button" onClick={onPreview} disabled={disabled || device.bypassed || track.kind === "source" || !target}>Preview</button>
      <button type="button" className="primary" onClick={onApply} disabled={disabled || device.bypassed || !preview?.compoundLayerId || preview.generatedEdits === 0}>Apply morph state</button>
    </footer>
    <details className="dgw-device-details">
      <summary>Details</summary>
      {preview && <dl className="dgw-device-metadata">
        <div><dt>Track differences</dt><dd>{preview.differingPositions.toLocaleString()} positions · {preview.differingAlleles.toLocaleString()} allele-copy changes</dd></div>
        <div><dt>Preview state</dt><dd>{preview.selectedPositions.toLocaleString()} positions · {preview.generatedEdits.toLocaleString()} changes</dd></div>
      </dl>}
      <p className="dgw-device-limitation optimizer-limit"><b>Limit</b>{device.limitation}</p>
    </details>
  </section>;
}

function TrackMeterCard({
  meter,
  profiler,
  busy,
  onAnalyze
}: {
  meter: TrackMeterModel;
  profiler?: TrackProfilerModel;
  busy: boolean;
  onAnalyze?: () => void;
}) {
  const complete = meter.activeMutations > 0 && meter.evaluatedMutations === meter.activeMutations;
  const profilerProgress = Math.max(0, Math.min(100, profiler?.progress
    ?? (profiler?.totalMutations
      ? Math.round((profiler.processedMutations / profiler.totalMutations) * 100)
      : 0)));
  const delta = complete ? meter.impactDelta : undefined;
  const meanDelta = delta === undefined ? undefined : delta / meter.activeMutations;
  const fill = meanDelta === undefined ? 0 : Math.min(50, Math.abs(meanDelta) * 50);
  const state = meanDelta === undefined ? "incomplete" : meanDelta > 0 ? "red" : meanDelta < 0 ? "green" : "zero";
  const distribution = complete
    && meter.higherImpactMutations !== undefined
    && meter.lowerImpactMutations !== undefined
    && meter.unchangedImpactMutations !== undefined
    && meter.higherImpactMutations + meter.lowerImpactMutations + meter.unchangedImpactMutations === meter.activeMutations
    ? {
      higher: meter.higherImpactMutations,
      lower: meter.lowerImpactMutations,
      unchanged: meter.unchangedImpactMutations
    }
    : undefined;
  const run = meter.appliedRun;
  const runDelta = run?.beforeScore !== undefined && run.afterScore !== undefined
    ? run.afterScore - run.beforeScore
    : undefined;
  const runPercent = runDelta !== undefined && run?.beforeScore
    ? (runDelta / Math.abs(run.beforeScore)) * 100
    : undefined;
  return <section className={`dgw-track-meter ${state}`} aria-label="Track Meter">
    <header>
      <div><small>Compared with source</small><b>Consequence impact</b></div>
    </header>
    <div className="dgw-monitor-coverage" aria-label="Mutation evaluation coverage">
      <span><b>{meter.evaluatedMutations.toLocaleString()}</b> / {meter.activeMutations.toLocaleString()} mutations evaluated</span>
      <span>{meter.activeMutations === 0 ? "No active edits" : complete ? "Complete" : "Incomplete"}</span>
    </div>
    {run && <section className={`dgw-monitor-device-run${run.active ? " is-active" : " is-bypassed"}`} aria-label={`${run.device} ${run.mode} result`}>
      <header><span>{run.device}</span><b>{run.mode} · {run.direction}</b></header>
      <div className="dgw-monitor-run-score">
        <small>{run.active ? "Applied objective movement" : run.generatedEdits === 0 ? "No edits generated" : "Run bypassed"}</small>
        <strong>{run.beforeScore === undefined || run.afterScore === undefined
          ? "—"
          : `${run.beforeScore.toFixed(1)} → ${run.afterScore.toFixed(1)}`}</strong>
        {runDelta !== undefined && <b className={runDelta < 0 ? "is-lower" : runDelta > 0 ? "is-higher" : "is-same"}>
          {runDelta > 0 ? "+" : ""}{runDelta.toFixed(1)}{runPercent !== undefined ? ` · ${runPercent > 0 ? "+" : ""}${runPercent.toFixed(1)}%` : ""}
        </b>}
      </div>
      <footer>
        <span>{run.consideredPositions} positions scanned</span>
        <span>{run.evaluatedCandidates} ALTs evaluated</span>
        <span>{run.changedPositions} positions changed</span>
        <span>{run.activeEdits}/{run.generatedEdits} blocks active</span>
      </footer>
    </section>}
    <div className="dgw-meter-body">
      <div className="dgw-meter-scale" aria-label={meanDelta === undefined ? "Mean impact delta incomplete" : `Mean impact delta ${meanDelta.toFixed(4)} per mutation`}>
        <div className="dgw-red-zone" />
        <div className="dgw-meter-zero"><span>0</span></div>
        {meanDelta !== undefined && <div className={`dgw-meter-fill ${meanDelta > 0 ? "positive" : "negative"}`} style={{ height: `${fill}%` }} />}
      </div>
      <div className="dgw-meter-readout">
        <small>Mean Δ per mutation</small>
        <strong>{meanDelta === undefined ? "—" : `${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(4)}`}</strong>
        <span>{meanDelta === undefined ? meter.activeMutations === 0 ? "Edit a track to compare" : profiler?.status === "running" ? "Updating…" : "Awaiting complete evaluation" : meanDelta > 0 ? "Higher than source" : meanDelta < 0 ? "Lower than source" : "Unchanged from source"}</span>
        <div className="dgw-meter-total">
          <span>Total Δ <small>model units</small></span>
          <b>{delta === undefined ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`}</b>
        </div>
      </div>
    </div>
    {distribution && <section className="dgw-impact-distribution" aria-label="Molecular-impact direction distribution">
      <div className="dgw-impact-distribution-bar" aria-hidden="true">
        <span className="is-lower" style={{ width: `${(distribution.lower / meter.activeMutations) * 100}%` }} />
        <span className="is-unchanged" style={{ width: `${(distribution.unchanged / meter.activeMutations) * 100}%` }} />
        <span className="is-higher" style={{ width: `${(distribution.higher / meter.activeMutations) * 100}%` }} />
      </div>
      <div className="dgw-impact-distribution-legend">
        <span><i className="is-lower" />Lower <b>{distribution.lower.toLocaleString()}</b></span>
        <span><i className="is-unchanged" />Unchanged <b>{distribution.unchanged.toLocaleString()}</b></span>
        <span><i className="is-higher" />Higher <b>{distribution.higher.toLocaleString()}</b></span>
      </div>
      {distribution.unchanged === meter.activeMutations && <p className="muted">The DNA changed, but every evaluated allele remained in the same coarse consequence-impact class as its source allele.</p>}
    </section>}
    <div className="dgw-meter-devices">
      {meter.deviceCoverage.map((device) => <div className={device.bypassed ? "is-bypassed" : ""} key={device.id} title={device.bypassed ? "Device bypassed; retained results do not contribute" : (device.unavailable ?? 0) > 0 ? `${(device.unavailable ?? 0).toLocaleString()} mutations could not be evaluated because the resource is unavailable` : (device.errors ?? 0) > 0 ? `${(device.errors ?? 0).toLocaleString()} mutations returned an error` : device.id === CONSEQUENCE_DEVICE_ID ? `${(device.noTranscriptFeature ?? 0).toLocaleString()} current alleles had no overlapping transcript feature` : `${device.exactMatches} exact-match results`}>
        <span>{device.label}</span><b>{device.bypassed ? "Bypassed" : (device.errors ?? 0) > 0 ? "Error" : (device.unavailable ?? 0) > 0 ? "Unavailable" : `${device.evaluated}/${device.total}`}</b>
      </div>)}
    </div>
    <details className="dgw-monitor-details">
      <summary>Individual edits</summary>
      <div className="dgw-meter-edits">
      {meter.items.length === 0 ? <p>No active mutation blocks yet.</p> : meter.items.map((item) => <div className={`${item.enabled ? "" : "bypassed"}${item.evaluated ? " evaluated" : ""}`} key={item.editId}>
        <span>{item.label}</span>
        <b>{!item.enabled ? "bypassed" : item.impactDelta === undefined ? item.evaluated ? "profiled" : "not evaluated" : `${item.impactDelta >= 0 ? "+" : ""}${item.impactDelta.toFixed(2)}`}</b>
      </div>)}
      </div>
    </details>
    <div className="dgw-profiler-actions">
      <div>
        <div className="dgw-profiler-heading">
          <b>Track Profiler</b>
          {profiler?.status === "running" && <strong>{profilerProgress}%</strong>}
        </div>
        {profiler?.status === "running" && <div
          className="dgw-profiler-progress"
          role="progressbar"
          aria-label="Track Profiler progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={profilerProgress}
        >
          <span style={{ width: `${profilerProgress}%` }} />
        </div>}
        <small>{profiler?.message ?? "Run applied Evidence devices across every active mutation."}</small>
      </div>
      <button type="button" onClick={onAnalyze} disabled={busy || profiler?.status === "running" || !onAnalyze || meter.activeMutations === 0}>
        {profiler?.status === "running"
          ? "Profiling…"
          : profiler?.status === "complete"
            ? "Refresh profile"
            : profiler?.status === "partial"
              ? "Retry profile"
              : "Analyze now"}
      </button>
    </div>
    <p className="dgw-meter-limit">Additive allele-level signal. It is not disease probability and does not model combined effects.</p>
    <details className="dgw-monitor-details">
      <summary>How to read this</summary>
      <p>Mean Δ is the total source-relative consequence-impact change divided by the number of active mutations. Total Δ also depends on how many mutations are active. These values appear only when all active mutations have been evaluated and an impact result is available.</p>
      <p>Higher and lower refer to the consequence model, not health. Database coverage is shown separately and is not added to this meter.</p>
    </details>
  </section>;
}

type RackItem =
  | { type: "optimizer"; order: number; device: GenomeOptimizerDevice }
  | { type: "randomizer"; order: number; device: AlleleRandomizerDevice }
  | { type: "morph"; order: number; device: GenomeMorphDevice }
  | { type: "compact"; order: number; device: RackDeviceView };

type RackGroupId = "edit" | "evidence" | "analyze" | "visualize";

const RACK_GROUPS: Array<{ id: RackGroupId; label: string; description: string }> = [
  { id: "edit", label: "Edit", description: "Create reversible mutation blocks" },
  { id: "evidence", label: "Evidence", description: "Report allele annotations and observations" },
  { id: "analyze", label: "Analyze", description: "Apply an explicit track-level model" },
  { id: "visualize", label: "Visualize", description: "Explore track state and device results" }
];

function rackGroupId(item: RackItem): RackGroupId {
  if (item.type === "randomizer" || item.type === "morph") return "edit";
  if (item.type === "optimizer") return "analyze";
  if (item.device.kind === "visualization") return "visualize";
  return item.device.kind === "editing" ? "edit" : "evidence";
}

function DeviceBrowserItem({ item, applied, onAdd }: {
  item: RackItem;
  applied: boolean;
  onAdd?: () => void;
}) {
  const name = item.device.name ?? (item.type === "optimizer" ? "Genome Optimizer" : "Device");
  const target = item.type === "compact"
    ? rackTargetLabel(item.device.target)
    : item.type === "optimizer"
      ? rackTargetLabel(item.device.target ?? "focusedRegion")
      : item.type === "morph"
        ? "Another compatible track"
        : "Selected variants";
  return <button type="button" className="dgw-device-browser-item" onClick={onAdd} disabled={applied || !onAdd}>
    <span className={`dgw-device-light ${deviceLightState(item.device.status, !applied || item.device.bypassed)}`} aria-hidden="true" />
    <span><b>{name}</b><small>{target}</small></span>
    <em>{applied ? "Applied" : "Add"}</em>
  </button>;
}

function VariantMapPanel({
  track,
  region,
  meter,
  selectedEditId,
  selectedAlleleIds,
  onSelectEdit,
  onSelectAllele,
  onClose
}: {
  track: GenomeTrackModel;
  region: FocusContext;
  meter?: TrackMeterModel;
  selectedEditId?: string;
  selectedAlleleIds: string[];
  onSelectEdit: (editId: string) => void;
  onSelectAllele: (alleleId: string, additive: boolean) => void;
  onClose: () => void;
}) {
  const sourceMarks = sampleVariantMapMarks(
    [...track.alleles].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)),
    480
  );
  const activeEdits = (meter?.items ?? [])
    .filter((item) => item.enabled && item.contig === region.contig && item.position >= region.start && item.position <= region.end)
    .sort((left, right) => left.position - right.position || left.editId.localeCompare(right.editId));
  const compactBulkLayers = (meter?.items ?? [])
    .filter((item) => item.enabled && (item.mutationCount ?? 1) > 1);
  const compactBulkMutations = compactBulkLayers.reduce(
    (total, item) => total + (item.mutationCount ?? 1),
    0
  );
  const editMarks = sampleVariantMapMarks(activeEdits, 500);
  const evaluatedEdits = activeEdits.filter((item) => item.evaluated && item.impactDelta !== undefined);
  const scale = Math.max(0.33, ...evaluatedEdits.map((item) => Math.abs(item.impactDelta ?? 0)));
  const ticks = viewportTicks(region);
  const xFor = (position: number) => 72 + positionPercent(position, region) * 9;
  const toneLabel = (delta?: number) => {
    const tone = variantMapTone(delta);
    if (tone === "unknown") return "not evaluated";
    if (tone === "neutral") return "no molecular-impact change";
    return `${tone} molecular-impact output`;
  };
  const deltaLabel = (delta?: number) => delta === undefined ? "unknown" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`;

  return <section className="dgw-variant-map" aria-label="Variant Map visualization">
    <header className="dgw-variant-map-header">
      <div><span>Variant Map</span><small>{track.name} · {region.contig}:{region.start.toLocaleString()}–{region.end.toLocaleString()} · 1-based positions</small></div>
      <button type="button" onClick={onClose}>Back to rack</button>
    </header>

    <div className="dgw-variant-map-summary">
      <div><small>Visible alleles</small><b>{track.alleles.length.toLocaleString()}</b></div>
      <div><small>Active edits</small><b>{activeEdits.length.toLocaleString()}</b></div>
      <div><small>Evaluated edits</small><b>{evaluatedEdits.length.toLocaleString()} / {activeEdits.length.toLocaleString()}</b></div>
      {compactBulkMutations > 0 && <div className="bulk"><small>Compact bulk mutations</small><b>{compactBulkMutations.toLocaleString()}</b></div>}
      <p>Transcript-consequence impact Δ relative to the source allele</p>
    </div>

    <div className="dgw-variant-map-chart">
      <svg viewBox="0 0 1000 240" role="img" aria-label="Source-relative molecular-impact changes by genomic position">
        <line className="map-grid" x1="72" x2="972" y1="34" y2="34" />
        <line className="map-source-line" x1="72" x2="972" y1="120" y2="120" />
        <line className="map-grid" x1="72" x2="972" y1="206" y2="206" />
        <text className="map-axis-label higher" x="10" y="38">HIGHER</text>
        <text className="map-axis-label" x="10" y="124">SOURCE</text>
        <text className="map-axis-label lower" x="10" y="210">LOWER</text>
        <text className="map-scale-label" x="976" y="38" textAnchor="end">+{scale.toFixed(2)}</text>
        <text className="map-scale-label" x="976" y="210" textAnchor="end">−{scale.toFixed(2)}</text>

        {ticks.map((position) => {
          const x = xFor(position);
          return <g className="map-position-tick" key={position}>
            <line x1={x} x2={x} y1="34" y2="206" />
            <text x={x} y="230" textAnchor="middle">{position.toLocaleString()}</text>
          </g>;
        })}

        {sourceMarks.map((allele) => {
          const x = xFor(allele.position);
          const y = 120 + ((allele.stackIndex ?? 0) - ((allele.stackCount ?? 1) - 1) / 2) * 12;
          const selected = selectedAlleleIds.includes(allele.id);
          return <g
            className={`map-source-mark${selected ? " is-selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`${region.contig}:${allele.position} ${allele.reference} to ${allele.alternate}`}
            onClick={(event) => onSelectAllele(allele.id, event.ctrlKey || event.metaKey)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectAllele(allele.id, event.ctrlKey || event.metaKey);
              }
            }}
            key={allele.id}
          >
            <line x1={x} x2={x} y1={Math.min(120, y)} y2={Math.max(120, y)} />
            <circle cx={x} cy={y} r={selected ? 5 : 3.5} />
            <title>{region.contig}:{allele.position.toLocaleString()} · {allele.reference}→{allele.alternate} · {allele.origin}</title>
          </g>;
        })}

        {editMarks.map((item) => {
          const x = xFor(item.position);
          const y = variantMapY(item.impactDelta, scale, 34, 120, 206);
          const tone = variantMapTone(item.impactDelta);
          const selected = selectedEditId === item.editId;
          const size = selected ? 9 : 7;
          const label = `${region.contig}:${item.position} ${item.reference} to ${item.alternate}; ${toneLabel(item.impactDelta)}; delta ${deltaLabel(item.impactDelta)}`;
          return <g
            className={`map-edit-mark ${tone}${selected ? " is-selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={label}
            onClick={() => onSelectEdit(item.editId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectEdit(item.editId);
              }
            }}
            key={item.editId}
          >
            <line className="map-delta-stem" x1={x} x2={x} y1="120" y2={y} />
            <path d={`M ${x} ${y - size} L ${x + size} ${y} L ${x} ${y + size} L ${x - size} ${y} Z`} />
            <title>{label}</title>
          </g>;
        })}
      </svg>
      {activeEdits.length === 0 && compactBulkMutations === 0 && <p className="dgw-variant-map-empty">No active mutation blocks in this region. Source VCF alleles remain visible on the center line.</p>}
      {compactBulkMutations > 0 && <p className="dgw-variant-map-empty bulk-layer-note"><b>{compactBulkMutations.toLocaleString()} active mutations are stored in {compactBulkLayers.length === 1 ? "a compact bulk layer" : `${compactBulkLayers.length} compact bulk layers`}.</b> Variant Map does not yet expand bulk layers into position-level marks. Use Track Monitor for the aggregate profile; ordinary allele-level blocks remain visible here.</p>}
    </div>

    <footer className="dgw-variant-map-footer">
      <div className="dgw-variant-map-legend"><span className="higher"><i />Higher</span><span className="neutral"><i />No change</span><span className="lower"><i />Lower</span><span className="unknown"><i />Not evaluated</span></div>
      <p>Higher and lower mean only the displayed source-relative consequence model output. They do not mean diseased, healthy, pathogenic, or benign. Nearby allele interactions are not modeled.</p>
      {(track.alleles.length > sourceMarks.length || activeEdits.length > editMarks.length) && <small>Dense view: showing {sourceMarks.length.toLocaleString()} representative allele marks and {editMarks.length.toLocaleString()} representative active edits.</small>}
    </footer>
  </section>;
}

function DeviceRack({
  track,
  tracks,
  selectedAlleleCount,
  interactiveAlleleLimit,
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
  onMorphChange,
  onMorphPreview,
  onMorphApply,
  onMorphBypass,
  onSelectDevice,
  onToggleDevice,
  onRunDevice,
  onOpenVisualization,
  appliedDeviceIds,
  onAddDevice,
  onRemoveDevice,
  onResetDevice,
  openBrowserRequest
}: {
  track?: GenomeTrackModel;
  tracks: GenomeTrackModel[];
  selectedAlleleCount: number;
  interactiveAlleleLimit: number;
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
  onMorphChange?: (settings: GenomeMorphSettings) => void;
  onMorphPreview?: () => void;
  onMorphApply?: () => void;
  onMorphBypass?: (bypassed: boolean) => void;
  onSelectDevice?: (deviceId: string) => void;
  onToggleDevice?: (deviceId: string, bypassed: boolean) => void;
  onRunDevice?: (deviceId: string) => void;
  onOpenVisualization?: (deviceId: string) => void;
  appliedDeviceIds: string[];
  onAddDevice?: (deviceId: string) => void;
  onRemoveDevice?: (deviceId: string) => void;
  onResetDevice?: (deviceId: string) => void;
  openBrowserRequest?: number;
}) {
  const [deviceBrowserOpen, setDeviceBrowserOpen] = useState(false);
  useEffect(() => {
    if (openBrowserRequest) setDeviceBrowserOpen(true);
  }, [openBrowserRequest]);
  if (!track) {
    return <aside className="dgw-device-rack is-empty" data-context-help="device-rack"><p>Select a genome track to see its devices.</p></aside>;
  }
  const selectedRackTrack = track;

  const compactDevices = rackDevices.filter((item) => item.id !== track.optimizer?.id && item.id !== track.randomizer?.id);
  const catalogItems: RackItem[] = compactDevices.map((device) => ({ type: "compact", order: device.order, device }));
  if (track.optimizer) {
    catalogItems.push({ type: "optimizer", order: track.optimizer.rackOrder ?? 0, device: track.optimizer });
  }
  if (track.randomizer) {
    catalogItems.push({ type: "randomizer", order: track.randomizer.rackOrder ?? 0, device: track.randomizer });
  }
  if (track.morph) {
    catalogItems.push({ type: "morph", order: track.morph.rackOrder ?? 0, device: track.morph });
  }
  catalogItems.sort((left, right) => left.order - right.order || left.device.id.localeCompare(right.device.id));
  const appliedSet = new Set(appliedDeviceIds);
  const dgwStarterIds = catalogItems.map((item) => item.device.id);
  const matchesDgwStarter = dgwStarterIds.length > 0 && appliedDeviceIds.length === dgwStarterIds.length
    && appliedDeviceIds.every((id, index) => id === dgwStarterIds[index]);
  const rackTemplateName = matchesDgwStarter ? "DGW Starter" : appliedDeviceIds.length === 0 ? "Empty Rack" : "Custom rack";
  const rackItems = catalogItems
    .filter((item) => appliedSet.has(item.device.id))
    .sort((left, right) => appliedDeviceIds.indexOf(left.device.id) - appliedDeviceIds.indexOf(right.device.id));
  const browserGroups = RACK_GROUPS.map((group) => ({
    ...group,
    items: catalogItems.filter((item) => rackGroupId(item) === group.id)
  })).filter((group) => group.items.length > 0);
  const selectedItem = rackItems.find((item) => item.device.id === selectedDeviceId) ?? rackItems[0];
  const selectedRackDeviceId = selectedItem?.device.id;
  const selectedDeviceCanReset = selectedItem?.type === "optimizer" || selectedItem?.type === "randomizer" || selectedItem?.type === "morph";
  const selectedDeviceRunning = selectedItem?.device.status === "running";

  function openDeviceBrowser() {
    setDeviceBrowserOpen(true);
  }

  function renderRackItem(item: RackItem) {
    return item.type === "optimizer" ? (
      <OptimizerDeviceCard
        key={item.device.id}
        track={selectedRackTrack}
        device={item.device}
        objectives={objectives}
        weightControls={weightControls}
        selectedCount={selectedAlleleCount}
        selected={selectedRackDeviceId === item.device.id}
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
        interactiveMaterializationLimit={interactiveAlleleLimit}
        selected={selectedRackDeviceId === item.device.id}
        busy={busy}
        onSelect={onSelectDevice ? () => onSelectDevice(item.device.id) : undefined}
        onChange={onRandomizerChange ?? (() => undefined)}
        onPreview={onRandomizerPreview ?? (() => undefined)}
        onApply={onRandomizerApply ?? (() => undefined)}
        onBypass={onRandomizerBypass ?? (() => undefined)}
      />
    ) : item.type === "morph" ? (
      <GenomeMorphDeviceCard
        key={item.device.id}
        track={selectedRackTrack}
        targets={tracks.filter((candidate) => candidate.id !== selectedRackTrack.id)}
        device={item.device}
        selected={selectedRackDeviceId === item.device.id}
        busy={busy}
        onSelect={onSelectDevice ? () => onSelectDevice(item.device.id) : undefined}
        onChange={onMorphChange ?? (() => undefined)}
        onPreview={onMorphPreview ?? (() => undefined)}
        onApply={onMorphApply ?? (() => undefined)}
        onBypass={onMorphBypass ?? (() => undefined)}
      />
    ) : (
      <CompactDeviceCard
        key={item.device.id}
        device={item.device}
        selected={selectedRackDeviceId === item.device.id}
        busy={busy}
        onSelect={onSelectDevice ? () => onSelectDevice(item.device.id) : undefined}
        onToggle={onToggleDevice ? (bypassed) => onToggleDevice(item.device.id, bypassed) : undefined}
        onRun={item.device.kind === "visualization"
          ? onOpenVisualization ? () => onOpenVisualization(item.device.id) : undefined
          : onRunDevice ? () => onRunDevice(item.device.id) : undefined}
      />
    );
  }

  return (
    <aside className={`dgw-device-rack${rackItems.length === 0 ? " is-empty" : ""}`} data-context-help="device-rack">
      <div className="dgw-device-rack-title">
        <div><span>Device rack</span><small title={rackTemplateName}>{track.name}</small></div>
        <div className="dgw-device-rack-actions">
          <button type="button" onClick={openDeviceBrowser} disabled={busy}><Plus aria-hidden="true" /> Add device</button>
          <button
            type="button"
            onClick={() => selectedItem && onResetDevice?.(selectedItem.device.id)}
            disabled={busy || selectedDeviceRunning || !selectedDeviceCanReset || !onResetDevice}
            title={!selectedDeviceCanReset ? "The selected device has no adjustable state" : "Restore factory controls and discard the current uncommitted result"}
            aria-label="Reset selected"
          ><RotateCcw aria-hidden="true" /></button>
          <button
            type="button"
            onClick={() => selectedItem && onRemoveDevice?.(selectedItem.device.id)}
            disabled={busy || !selectedItem || !onRemoveDevice}
            title="Remove selected device"
            aria-label="Remove selected device"
          ><Trash2 aria-hidden="true" /></button>
        </div>
      </div>

      <div className="dgw-device-rack-body">
          <div className="dgw-device-chain" aria-label={`Applied devices for ${track.name}`}>
            {rackItems.length > 0 ? rackItems.map(renderRackItem) : <button type="button" className="dgw-empty-device-chain" onClick={openDeviceBrowser}>
              <b>No devices applied</b><small>Add a device to this Genome Track</small>
            </button>}
          </div>
          {deviceBrowserOpen && <section className="dgw-device-browser" aria-label="Device Browser">
            <header><div><span>Device Browser</span><small>Available devices · adding one does not change an objective automatically</small></div><button type="button" onClick={() => setDeviceBrowserOpen(false)}>Close</button></header>
            <div className="dgw-device-browser-content">
              <div className="dgw-device-browser-groups">{browserGroups.map((group) => <section className={`group-${group.id}`} key={group.id}>
              <header><b>{group.label}</b><small>{group.description}</small></header>
              <div>{group.items.map((item) => <DeviceBrowserItem
                item={item}
                applied={appliedSet.has(item.device.id)}
                onAdd={!busy && onAddDevice ? () => { onAddDevice(item.device.id); setDeviceBrowserOpen(false); } : undefined}
                key={item.device.id}
              />)}</div>
              </section>)}</div>
            </div>
          </section>}
        </div>
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
  selectedAlleleCount,
  interactiveAlleleLimit = 1_000,
  allAllelesSelected = false,
  objectives,
  weightControls,
  rackDevices = [],
  appliedDeviceIds = [],
  variantDensity,
  trackMeter,
  trackProfiler,
  showDeviceRack = true,
  showTrackMeter = true,
  deviceBrowserRequest,
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
  onMarqueeSelectAlleles,
  onSelectVisibleAlleles,
  onSelectAllAlleles,
  onClearAlleleSelection,
  onShowDeviceRack,
  onUndoAction,
  onRedoAction,
  onToggleEdit,
  onOptimizerChange,
  onOptimizerBypass,
  onRegenerate,
  onConsolidate,
  onRandomizerChange,
  onRandomizerPreview,
  onRandomizerApply,
  onRandomizerBypass,
  onMorphChange,
  onMorphPreview,
  onMorphApply,
  onMorphBypass,
  onSelectDevice,
  onToggleDevice,
  onRunDevice,
  onAddDevice,
  onRemoveDevice,
  onResetDevice,
  onAnalyzeTrack
}: TrackDeviceWorkspaceProps) {
  const selectedTrack = tracks.find((track) => track.id === selectedTrackId);
  const semanticSelectedAlleleCount = selectedAlleleCount ?? selectedAlleleIds.length;
  const visibleSelectedAlleleCount = selectedTrack?.alleles.filter((allele) => selectedAlleleIds.includes(allele.id)).length ?? 0;
  const selectionExtendsBeyondView = semanticSelectedAlleleCount > visibleSelectedAlleleCount;
  const span = viewportSpan(region);
  const ticks = viewportTicks(region);
  const [trackHeight, setTrackHeight] = useState(() => {
    const stored = Number(window.localStorage.getItem("dgw.track-height"));
    return Number.isFinite(stored) && stored >= 76 && stored <= 220 ? stored : 100;
  });
  const [minimizedTrackIds, setMinimizedTrackIds] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("dgw.minimized-track-ids") ?? "[]");
      return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  const [rackHeight, setRackHeight] = useState(() => {
    const stored = Number(window.localStorage.getItem("dgw.device-rack-height"));
    return Number.isFinite(stored) && stored >= MIN_RACK_HEIGHT ? stored : DEFAULT_RACK_HEIGHT;
  });
  const [openVisualizationId, setOpenVisualizationId] = useState<string>();
  const [resizingRack, setResizingRack] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const openVisualization = rackDevices.find((device) => (
    device.id === openVisualizationId
      && device.kind === "visualization"
      && appliedDeviceIds.includes(device.id)
      && !device.bypassed
  ));

  const openContextMenu = useCallback<OpenContextMenu>((menu) => setContextMenu(menu), []);
  const closeContextMenu = useCallback(() => {
    setContextMenu((current) => {
      const invoker = current?.invoker;
      if (invoker?.isConnected) window.requestAnimationFrame(() => invoker.focus());
      return undefined;
    });
  }, []);

  useEffect(() => {
    if (openVisualizationId && !openVisualization) setOpenVisualizationId(undefined);
  }, [openVisualization, openVisualizationId]);

  useEffect(() => {
    window.localStorage.setItem("dgw.track-height", String(trackHeight));
  }, [trackHeight]);

  useEffect(() => {
    window.localStorage.setItem("dgw.minimized-track-ids", JSON.stringify(minimizedTrackIds));
  }, [minimizedTrackIds]);

  useEffect(() => {
    window.localStorage.setItem("dgw.device-rack-height", String(rackHeight));
  }, [rackHeight]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const maximum = Math.max(
        MIN_RACK_HEIGHT,
        workspace.getBoundingClientRect().height - MIN_TRACK_DECK_HEIGHT - RACK_SEPARATOR_HEIGHT
      );
      setRackHeight((height) => Math.round(clamp(height, MIN_RACK_HEIGHT, maximum)));
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  function clampedRackHeight(pointerY: number) {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds) return rackHeight;
    const maximum = Math.max(MIN_RACK_HEIGHT, bounds.height - MIN_TRACK_DECK_HEIGHT - RACK_SEPARATOR_HEIGHT);
    return Math.round(clamp(bounds.bottom - pointerY, MIN_RACK_HEIGHT, maximum));
  }

  function beginRackResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingRack(true);
    setRackHeight(clampedRackHeight(event.clientY));
  }

  function moveRackResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizingRack || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setRackHeight(clampedRackHeight(event.clientY));
  }

  function endRackResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizingRack(false);
  }

  function resizeRackWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    const maximum = bounds
      ? Math.max(MIN_RACK_HEIGHT, bounds.height - MIN_TRACK_DECK_HEIGHT - RACK_SEPARATOR_HEIGHT)
      : rackHeight + 24;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setRackHeight((height) => Math.min(maximum, height + 24));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setRackHeight((height) => Math.max(MIN_RACK_HEIGHT, height - 24));
    } else if (event.key === "Home") {
      event.preventDefault();
      setRackHeight(Math.min(DEFAULT_RACK_HEIGHT, maximum));
    }
  }

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
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "z" && event.shiftKey && onRedoAction) {
        event.preventDefault();
        onRedoAction();
      } else if (command && event.key.toLowerCase() === "z" && onUndoAction) {
        event.preventDefault();
        onUndoAction();
      } else if (command && event.key.toLowerCase() === "a" && onSelectAllAlleles) {
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
  }, [contigLength, onRedoAction, onSelectAllAlleles, onUndoAction, onViewportChange, region, selectedPosition, selectedTrackId, span]);

  const showLowerPane = showDeviceRack || Boolean(detailPanel);

  return (
    <section
      className="dgw-track-device-workspace"
      aria-label="Genome tracks and device rack"
      style={{
        "--dgw-track-height": `${trackHeight}px`,
        "--dgw-device-rack-height": `${rackHeight}px`
      } as CSSProperties}
    >
      <div
        ref={workspaceRef}
        className={`dgw-workspace-main${showLowerPane ? "" : " hide-device-rack"}${detailPanel ? " allele-detail-open" : ""}`}
      >
      <div className="dgw-track-deck" onWheel={handleTrackWheel}>
        <header className="dgw-track-deck-header">
          <div className="dgw-track-heading">
            <span>Tracks <b className="dgw-edit-target" title="Edits and devices act on this selected track">{selectedTrack?.name}</b></span>
            <details className="dgw-track-help">
              <summary>Track help</summary>
              <div>Diamonds mark VCF alleles; rectangles mark mutation blocks. Drag across the active lane to select alleles; Ctrl/⌘-click toggles one. Ctrl/⌘ + wheel zooms; Shift + wheel pans.</div>
            </details>
          </div>
          <div className="dgw-viewport-controls" aria-label="Horizontal genome zoom controls">
            {!showDeviceRack && !detailPanel && <button
              type="button"
              className="fit"
              onClick={onShowDeviceRack}
              disabled={!onShowDeviceRack}
              title="Restore the Device Rack below the genome tracks"
            >Show devices</button>}
            <button type="button" onClick={() => pan(-0.35)} disabled={busy || !onViewportChange} title="Pan left" aria-label="Pan left"><ChevronLeft aria-hidden="true" /></button>
            <button type="button" onClick={() => zoom(1.6)} disabled={busy || !onViewportChange} title="Zoom out" aria-label="Zoom out"><ZoomOut aria-hidden="true" /></button>
            <code title={`${region.contig}:${region.start.toLocaleString()}–${region.end.toLocaleString()}`}>{span.toLocaleString()} bp</code>
            <button type="button" onClick={() => zoom(0.625)} disabled={busy || !onViewportChange} title="Zoom in" aria-label="Zoom in"><ZoomIn aria-hidden="true" /></button>
            <button type="button" onClick={() => pan(0.35)} disabled={busy || !onViewportChange} title="Pan right" aria-label="Pan right"><ChevronRight aria-hidden="true" /></button>
            <button
              type="button"
              className="fit"
              onClick={() => selectedPosition !== undefined && updateViewport(focusViewport(region, selectedPosition, contigLength))}
              disabled={busy || !onViewportChange || selectedPosition === undefined}
              title="Fit selected allele (0)"
            ><LocateFixed aria-hidden="true" /> Fit allele</button>
            <span className="dgw-selection-controls" aria-label="Allele selection controls">
              <output
                className={`dgw-selection-count${semanticSelectedAlleleCount === 0 ? " is-empty" : ""}${selectionExtendsBeyondView ? " has-offscreen" : ""}`}
                aria-live="polite"
                title={selectionExtendsBeyondView ? `${visibleSelectedAlleleCount.toLocaleString()} selected alleles are shown in the current interval` : undefined}
              >
                <b>{semanticSelectedAlleleCount.toLocaleString()}</b>
                <span>{semanticSelectedAlleleCount === 1 ? "allele selected" : "alleles selected"}</span>
                {selectionExtendsBeyondView && <em>{visibleSelectedAlleleCount.toLocaleString()} shown</em>}
              </output>
              <button type="button" onClick={() => onSelectVisibleAlleles?.(selectedTrackId)} disabled={busy || !onSelectVisibleAlleles || (selectedTrack?.alleles.length ?? 0) === 0} title="Select VCF alleles visible in the current interval">Select visible</button>
              <button
                type="button"
                className={allAllelesSelected ? "is-active" : undefined}
                aria-pressed={allAllelesSelected}
                onClick={() => onSelectAllAlleles?.(selectedTrackId)}
                disabled={busy || !onSelectAllAlleles}
                title="Select every VCF allele in this track across all chromosomes (Ctrl/Command+A)"
              >{allAllelesSelected ? "All selected ✓" : "Select all in track"}</button>
              <button type="button" onClick={onClearAlleleSelection} disabled={busy || !onClearAlleleSelection || semanticSelectedAlleleCount === 0}>Clear</button>
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
              density={variantDensity}
              selected={track.id === selectedTrackId}
              selectedEditId={selectedEditId}
              selectedAlleleId={selectedAlleleId}
              selectedAlleleIds={selectedAlleleIds}
              busy={busy}
              canDelete={track.kind === "candidate"}
              minimized={minimizedTrackIds.includes(track.id)}
              onSelect={() => onSelectTrack(track.id)}
              onDuplicate={() => onDuplicateTrack(track.id)}
              onRename={(name) => onRenameTrack(track.id, name)}
              onDelete={() => onDeleteTrack(track.id)}
              onToggleVisibility={(visible) => onToggleTrackVisibility(track.id, visible)}
              onToggleMinimized={() => setMinimizedTrackIds((current) => current.includes(track.id)
                ? current.filter((id) => id !== track.id)
                : [...current, track.id])}
              onSelectEdit={(editId) => onSelectEdit(track.id, editId)}
              onSelectAllele={(alleleId, additive) => onSelectAllele(track.id, alleleId, additive)}
              onMarqueeSelectAlleles={onMarqueeSelectAlleles ? (alleleIds, additive) => onMarqueeSelectAlleles(track.id, alleleIds, additive) : undefined}
              onToggleEdit={(editId, enabled) => onToggleEdit(track.id, editId, enabled)}
              onAnalyze={onAnalyzeTrack ? () => onAnalyzeTrack(track.id) : undefined}
              onFocusPosition={(position) => updateViewport(focusViewport(region, position, contigLength))}
              onFocusRange={(start, end) => updateViewport({ contig: region.contig, start, end })}
              onSelectDevice={onSelectDevice ? (deviceId) => onSelectDevice(track.id, deviceId) : undefined}
              onOpenContextMenu={openContextMenu}
            />
          ))}
          {tracks.length === 0 && <p className="dgw-track-empty">No genome tracks are available.</p>}
        </div>

      </div>

      {showLowerPane && <div
        className={`dgw-lower-separator${resizingRack ? " is-resizing" : ""}`}
        role="separator"
        aria-label={`Resize tracks and ${detailPanel ? "Allele editor" : "Device Rack"}`}
        aria-orientation="horizontal"
        aria-valuemin={MIN_RACK_HEIGHT}
        aria-valuenow={rackHeight}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={beginRackResize}
        onPointerMove={moveRackResize}
        onPointerUp={endRackResize}
        onPointerCancel={endRackResize}
        onDoubleClick={() => setRackHeight(DEFAULT_RACK_HEIGHT)}
        onKeyDown={resizeRackWithKeyboard}
      ><span aria-hidden="true" /></div>}
      {showLowerPane && <div className="dgw-lower-pane">
        <div className="dgw-lower-main">{detailPanel ?? (openVisualization && selectedTrack ? <VariantMapPanel
          track={selectedTrack}
          region={region}
          meter={trackMeter}
          selectedEditId={selectedEditId}
          selectedAlleleIds={selectedAlleleIds}
          onSelectEdit={(editId) => onSelectEdit(selectedTrack.id, editId)}
          onSelectAllele={(alleleId, additive) => onSelectAllele(selectedTrack.id, alleleId, additive)}
          onClose={() => setOpenVisualizationId(undefined)}
        /> : <DeviceRack
          track={selectedTrack}
          tracks={tracks}
          selectedAlleleCount={semanticSelectedAlleleCount}
          interactiveAlleleLimit={interactiveAlleleLimit}
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
          onMorphChange={onMorphChange && selectedTrack ? (settings) => onMorphChange(selectedTrack.id, settings) : undefined}
          onMorphPreview={onMorphPreview && selectedTrack ? () => onMorphPreview(selectedTrack.id) : undefined}
          onMorphApply={onMorphApply && selectedTrack ? () => onMorphApply(selectedTrack.id) : undefined}
          onMorphBypass={onMorphBypass && selectedTrack ? (bypassed) => onMorphBypass(selectedTrack.id, bypassed) : undefined}
          onSelectDevice={onSelectDevice && selectedTrack ? (deviceId) => onSelectDevice(selectedTrack.id, deviceId) : undefined}
          onToggleDevice={onToggleDevice && selectedTrack ? (deviceId, bypassed) => onToggleDevice(selectedTrack.id, deviceId, bypassed) : undefined}
          onRunDevice={onRunDevice && selectedTrack ? (deviceId) => onRunDevice(selectedTrack.id, deviceId) : undefined}
          onOpenVisualization={(deviceId) => setOpenVisualizationId(deviceId)}
          appliedDeviceIds={appliedDeviceIds}
          onAddDevice={onAddDevice && selectedTrack ? (deviceId) => onAddDevice(selectedTrack.id, deviceId) : undefined}
          onRemoveDevice={onRemoveDevice && selectedTrack ? (deviceId) => onRemoveDevice(selectedTrack.id, deviceId) : undefined}
          onResetDevice={onResetDevice && selectedTrack ? (deviceId) => onResetDevice(selectedTrack.id, deviceId) : undefined}
          openBrowserRequest={deviceBrowserRequest}
        />)}</div>
      </div>}
      </div>
      {showTrackMeter && trackMeter && <aside className="dgw-track-monitor" aria-label="Track Monitor" data-context-help="track-monitor">
        <header><span>Track Monitor</span><small>{selectedTrack?.name ?? "Selected track"}</small></header>
        <div className="dgw-track-monitor-body"><TrackMeterCard
          meter={trackMeter}
          profiler={trackProfiler}
          busy={busy}
          onAnalyze={onAnalyzeTrack && selectedTrack ? () => onAnalyzeTrack(selectedTrack.id) : undefined}
        /></div>
      </aside>}
      {contextMenu && <ContextMenu menu={contextMenu} onClose={closeContextMenu} />}
    </section>
  );
}
