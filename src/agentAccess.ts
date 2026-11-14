import type { VariantSelection } from "./types";

/** The desktop shares project access; selection is explicit tool context, never an implicit whole-track request. */
export function agentSelection(selection: VariantSelection) {
  if (selection.kind === "allTrack") return { kind: "whole_track", exclusions: selection.exclusions };
  if (selection.kind === "interval") return { kind: "interval", contig: selection.contig, start: selection.start, end: selection.end, exclusions: selection.exclusions };
  return { kind: "explicit", variants: selection.variants };
}
