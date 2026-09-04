import { describe, expect, it } from "vitest";
import { focusViewport, panViewport, viewportSpan, zoomViewport } from "./genomeViewport";

describe("genome viewport", () => {
  it("zooms around the requested pointer anchor", () => {
    const region = { contig: "7", start: 100, end: 199 };
    expect(zoomViewport(region, 0.5, 0)).toEqual({ contig: "7", start: 100, end: 149 });
    expect(zoomViewport(region, 0.5, 1)).toEqual({ contig: "7", start: 150, end: 199 });
    expect(viewportSpan(zoomViewport(region, 2, 0.5))).toBe(200);
  });

  it("clamps zoom and pan to the reference contig", () => {
    expect(panViewport({ contig: "1", start: 10, end: 109 }, -500, 1_000))
      .toEqual({ contig: "1", start: 1, end: 100 });
    expect(panViewport({ contig: "1", start: 900, end: 999 }, 500, 1_000))
      .toEqual({ contig: "1", start: 901, end: 1_000 });
    expect(viewportSpan(zoomViewport({ contig: "1", start: 1, end: 100 }, 0.01))).toBe(20);
    expect(viewportSpan(zoomViewport({ contig: "1", start: 1, end: 10_000 }, 10))).toBe(50_000);
    expect(zoomViewport({ contig: "1", start: 1, end: 50_000 }, 10, 0.5, 248_000_000))
      .toEqual({ contig: "1", start: 1, end: 500_000 });
  });

  it("fits a selected allele into an 81-base window", () => {
    expect(focusViewport({ contig: "7", start: 1, end: 500 }, 140_453_136))
      .toEqual({ contig: "7", start: 140_453_096, end: 140_453_176 });
  });
});
