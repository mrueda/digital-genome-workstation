import type { FocusContext } from "./types";

export const MIN_VIEWPORT_BASES = 20;
export const MAX_VIEWPORT_BASES = 50_000;

export function viewportSpan(region: FocusContext) {
  return Math.max(1, region.end - region.start + 1);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function boundedRegion(
  contig: string,
  requestedStart: number,
  requestedSpan: number,
  contigLength?: number
): FocusContext {
  const maximumSpan = Math.max(1, Math.min(MAX_VIEWPORT_BASES, contigLength ?? MAX_VIEWPORT_BASES));
  const minimumSpan = Math.min(MIN_VIEWPORT_BASES, maximumSpan);
  const span = clamp(Math.round(requestedSpan), minimumSpan, maximumSpan);
  const maximumStart = Math.max(1, (contigLength ?? Number.MAX_SAFE_INTEGER) - span + 1);
  const start = clamp(Math.round(requestedStart), 1, maximumStart);
  return { contig, start, end: start + span - 1 };
}

/** factor < 1 zooms in; factor > 1 zooms out. */
export function zoomViewport(
  region: FocusContext,
  factor: number,
  anchorFraction = 0.5,
  contigLength?: number
): FocusContext {
  const span = viewportSpan(region);
  const anchor = clamp(anchorFraction, 0, 1);
  const anchorBase = region.start + anchor * (span - 1);
  const requestedSpan = span * clamp(factor, 0.1, 10);
  const requestedStart = anchorBase - anchor * (requestedSpan - 1);
  return boundedRegion(region.contig, requestedStart, requestedSpan, contigLength);
}

export function panViewport(
  region: FocusContext,
  deltaBases: number,
  contigLength?: number
): FocusContext {
  return boundedRegion(
    region.contig,
    region.start + Math.round(deltaBases),
    viewportSpan(region),
    contigLength
  );
}

export function focusViewport(
  region: FocusContext,
  position: number,
  contigLength?: number,
  span = 81
): FocusContext {
  return boundedRegion(region.contig, position - Math.floor(span / 2), span, contigLength);
}
