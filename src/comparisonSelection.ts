import type { VariantKey } from "./types";

// Track marker IDs retain the selected locus even when its ALT is replaced or
// restored to REF. Do not intersect them with the current viewport/effective ALTs.
export function comparisonKeysFromIds(ids: string[]): VariantKey[] {
  return [...new Set(ids)].flatMap(id => {
    const parts = id.split(":");
    const assembly = parts.shift();
    const alternate = parts.pop();
    const reference = parts.pop();
    const position = Number(parts.pop());
    const contig = parts.join(":");
    return assembly && alternate && reference && contig && Number.isSafeInteger(position) && position > 0
      ? [{ assembly, contig, position, reference, alternate }] : [];
  });
}
