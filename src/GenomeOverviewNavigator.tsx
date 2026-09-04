import {
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import { panViewport, viewportSpan, zoomViewport } from "./genomeViewport";
import type { FocusContext, VariantDensity } from "./types";
import { chromosomeLabel } from "./utils";

type DragMode = "pan" | "resize-start" | "resize-end";

interface DragState {
  mode: DragMode;
  pointerId: number;
  startX: number;
  width: number;
  region: FocusContext;
}

export function GenomeOverviewNavigator({
  density,
  region,
  contigLength,
  disabled = false,
  canCenterVariant = false,
  onCenterVariant,
  onResetView,
  onViewportChange
}: {
  density: VariantDensity;
  region: FocusContext;
  contigLength: number;
  disabled?: boolean;
  canCenterVariant?: boolean;
  onCenterVariant?: () => void;
  onResetView?: () => void;
  onViewportChange: (region: FocusContext) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const maximum = Math.max(1, ...density.bins.map((item) => item.count));
  const span = viewportSpan(region);
  const center = region.start + (span - 1) / 2;
  const centerPercent = Math.max(0, Math.min(100, ((center - 1) / Math.max(1, contigLength - 1)) * 100));
  const widthPercent = Math.max(0, Math.min(100, (span / contigLength) * 100));

  function zoom(factor: number, anchor = 0.5) {
    if (!disabled) onViewportChange(zoomViewport(region, factor, anchor, contigLength));
  }

  function recenter(clientX: number) {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds || disabled) return;
    const fraction = Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)));
    const requestedCenter = 1 + fraction * Math.max(0, contigLength - 1);
    onViewportChange(panViewport(region, requestedCenter - center, contigLength));
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>, mode: DragMode) {
    if (disabled || event.button !== 0) return;
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    const viewport = event.currentTarget.closest<HTMLElement>(".genome-overview-window");
    if (!viewport) return;
    viewport.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      width: Math.max(1, bounds.width),
      region
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const deltaX = event.clientX - drag.startX;
    if (drag.mode === "pan") {
      onViewportChange(panViewport(drag.region, (deltaX / drag.width) * contigLength, contigLength));
      return;
    }
    const direction = drag.mode === "resize-start" ? -1 : 1;
    const factor = Math.exp(direction * (deltaX / drag.width) * 6);
    onViewportChange(zoomViewport(drag.region, factor, drag.mode === "resize-start" ? 1 : 0, contigLength));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = undefined;
  }

  function handleKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      onViewportChange(panViewport(region, direction * span * (event.shiftKey ? 0.5 : 0.1), contigLength));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(0.625);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(1.6);
    }
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (disabled) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
      onViewportChange(panViewport(region, (event.deltaY / Math.max(1, bounds.width)) * span, contigLength));
      return;
    }
    const anchor = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    zoom(Math.exp(Math.max(-240, Math.min(240, event.deltaY)) * 0.0025), anchor);
  }

  return <div className="genome-overview-navigator" aria-label={`Chromosome ${density.context.contig} overview and viewport navigator`} data-context-help="chromosome-overview">
    <div className="genome-overview-heading">
      <span>Navigate</span>
      <b>{chromosomeLabel(density.context.contig)}</b>
      <small>{density.total.toLocaleString()} source alleles</small>
    </div>
    <div
      ref={trackRef}
      className={`genome-overview-track${disabled ? " is-disabled" : ""}`}
      onPointerDown={(event) => recenter(event.clientX)}
      onDoubleClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        zoom(0.4, Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))));
      }}
      onWheel={handleWheel}
      title="Click to recenter · drag the highlighted window to pan · drag its edges to zoom · wheel to zoom"
    >
      <div className="genome-overview-density" aria-hidden="true">
        {density.bins.map((bin, index) => {
          const height = bin.count === 0 ? 2 : 2 + 14 * Math.log1p(bin.count) / Math.log1p(maximum);
          return <i style={{ height }} key={`${bin.start}-${index}`} />;
        })}
      </div>
      <div
        className="genome-overview-window"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Visible genome interval"
        aria-valuemin={1}
        aria-valuemax={contigLength}
        aria-valuenow={Math.round(center)}
        aria-valuetext={`${region.contig}:${region.start}-${region.end}, ${span} bases`}
        style={{
          "--overview-center": `${centerPercent}%`,
          "--overview-width": `${widthPercent}%`
        } as CSSProperties}
        onPointerDown={(event) => beginDrag(event, "pan")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyboard}
      >
        <span
          className="genome-overview-handle start"
          role="separator"
          aria-label="Drag to change the visible interval start and zoom"
          onPointerDown={(event) => beginDrag(event, "resize-start")}
        />
        <span className="genome-overview-window-label">{span.toLocaleString()} bp</span>
        <span
          className="genome-overview-handle end"
          role="separator"
          aria-label="Drag to change the visible interval end and zoom"
          onPointerDown={(event) => beginDrag(event, "resize-end")}
        />
      </div>
    </div>
    <div className="genome-overview-controls" aria-label="Genome zoom controls">
      <button type="button" className="text" onClick={() => onViewportChange({ contig: region.contig, start: 1, end: contigLength })} disabled={disabled} title="Show the complete chromosome in Track View">Full chr</button>
      <button type="button" className="text" onClick={onResetView} disabled={disabled || !onResetView} title="Restore the viewport that was active when the project opened">Reset view</button>
      <button type="button" className="text" onClick={onCenterVariant} disabled={disabled || !canCenterVariant || !onCenterVariant} title="Center the last selected ALT at the current zoom">Center ALT</button>
      <button type="button" onClick={() => zoom(1.6)} disabled={disabled} title="Zoom out">−</button>
      <code>{region.start.toLocaleString()}–{region.end.toLocaleString()}</code>
      <button type="button" onClick={() => zoom(0.625)} disabled={disabled} title="Zoom in">+</button>
    </div>
  </div>;
}
