import { describe, it, expect } from "vitest";
import { agentSelection } from "./agentAccess";

describe("MCP desktop selection", () => {
  it("preserves empty selection instead of broadening it to the track", () => {
    expect(agentSelection({ kind: "explicit", trackId: "t", variants: [] })).toEqual({ kind: "explicit", variants: [] });
  });
  it("preserves whole-track exclusions and one-based region boundaries", () => {
    const key = { assembly: "b37", contig: "7", position: 100, reference: "A", alternate: "T" };
    expect(agentSelection({ kind: "allTrack", trackId: "t", exclusions: [key] })).toEqual({ kind: "whole_track", exclusions: [key] });
    expect(agentSelection({ kind: "interval", trackId: "t", contig: "7", start: 1, end: 100, exclusions: [key] })).toEqual({ kind: "interval", contig: "7", start: 1, end: 100, exclusions: [key] });
  });
});
