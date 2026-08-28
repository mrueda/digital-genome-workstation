import type { EffectiveVariant, Haplotype, VariantKey } from "./types";

export function variantLabel(key: VariantKey): string {
  return `${key.contig}:${key.position.toLocaleString()} ${key.reference}>${key.alternate}`;
}

export function shortId(id?: string): string {
  return id ? id.slice(0, 8) : "—";
}

export function sequenceChunks(sequence?: string, width = 10): string[] {
  if (!sequence) return [];
  return sequence.match(new RegExp(`.{1,${width}}`, "g")) ?? [];
}

export interface SequenceDisplayPart {
  text: string;
  role: "plain" | "reference" | "alternate";
  selected: boolean;
}

function sameVariant(left: VariantKey, right?: VariantKey): boolean {
  return Boolean(right)
    && left.assembly === right?.assembly
    && left.contig === right.contig
    && left.position === right.position
    && left.reference === right.reference
    && left.alternate === right.alternate;
}

export function sequenceDisplayParts(
  sequence: string | undefined,
  regionStart: number,
  regionEnd: number,
  variants: EffectiveVariant[],
  track: "reference" | "one" | "two",
  selected?: VariantKey
): SequenceDisplayPart[] {
  if (!sequence) return [];
  let offset = 0;
  const spans = variants
    .filter((variant) => {
      const applies = track === "reference"
        || (track === "one" ? variant.haplotype1Alt : variant.haplotype2Alt);
      return applies
        && variant.key.position >= regionStart
        && variant.key.position + variant.key.reference.length - 1 <= regionEnd;
    })
    .sort((left, right) => left.key.position - right.key.position)
    .map((variant) => {
      const start = variant.key.position - regionStart + (track === "reference" ? 0 : offset);
      const length = track === "reference" ? variant.key.reference.length : variant.key.alternate.length;
      if (track !== "reference") {
        offset += variant.key.alternate.length - variant.key.reference.length;
      }
      return {
        start,
        end: start + length,
        selected: sameVariant(variant.key, selected)
      };
    })
    .sort((left, right) => left.start - right.start || Number(right.selected) - Number(left.selected));

  const parts: SequenceDisplayPart[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor || span.start >= sequence.length) continue;
    if (span.start > cursor) {
      parts.push({ text: sequence.slice(cursor, span.start), role: "plain", selected: false });
    }
    parts.push({
      text: sequence.slice(span.start, Math.min(span.end, sequence.length)),
      role: track === "reference" ? "reference" : "alternate",
      selected: span.selected
    });
    cursor = Math.min(span.end, sequence.length);
  }
  if (cursor < sequence.length) {
    parts.push({ text: sequence.slice(cursor), role: "plain", selected: false });
  }
  return parts;
}

export function parentDirectory(path: string): string {
  return path.replace(/[\\/]?[^\\/]+$/, "");
}

export function projectSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "genome-project";
}

export function filterSamples(samples: string[], query: string, limit = 250): string[] {
  const normalized = query.trim().toLowerCase();
  return samples
    .filter((sample) => sample.toLowerCase().includes(normalized))
    .slice(0, limit);
}

export function variantPhaseLabel(variant: EffectiveVariant): string {
  if (variant.unphasedAlt) return "chromosome copy unknown";
  if (variant.haplotype1Alt && variant.haplotype2Alt) return "Chromosome copies A + B";
  if (variant.haplotype1Alt) return "Chromosome copy A";
  if (variant.haplotype2Alt) return "Chromosome copy B";
  return "reference";
}

export function haplotypeLabel(haplotype: Haplotype): string {
  if (haplotype === "one") return "Chromosome copy A";
  if (haplotype === "two") return "Chromosome copy B";
  return "chromosome copy unknown";
}
