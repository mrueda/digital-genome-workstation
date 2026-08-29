import type { EvidenceResult, VariantKey } from "./types";

export const AUTO_EVALUATION_DELAY_MS = 180;

export type SelectedAlleleEvidenceCache = Map<string, Record<string, EvidenceResult>>;

export function selectionEvidenceKey(key: VariantKey): string {
  return `${key.assembly}:${key.contig}:${key.position}:${key.reference}:${key.alternate}`;
}

export function cachedEvidenceForDevices(
  cache: SelectedAlleleEvidenceCache,
  alleleKey: string,
  deviceIds: readonly string[]
): Record<string, EvidenceResult> {
  const cached = cache.get(alleleKey) ?? {};
  return Object.fromEntries(deviceIds.flatMap((deviceId) => cached[deviceId] ? [[deviceId, cached[deviceId]]] : []));
}

export function missingEvidenceDeviceIds(
  cache: SelectedAlleleEvidenceCache,
  alleleKey: string,
  deviceIds: readonly string[]
): string[] {
  const cached = cache.get(alleleKey) ?? {};
  return deviceIds.filter((deviceId) => !cached[deviceId]);
}

export function cacheStableEvidence(
  cache: SelectedAlleleEvidenceCache,
  alleleKey: string,
  deviceId: string,
  evidence: EvidenceResult
): void {
  // Transient failures must be retried on the next selection. Only exact hits and
  // authoritative exact misses are safe to retain in the in-memory UI cache.
  if (evidence.status !== "found" && evidence.status !== "noExactMatch") return;
  cache.set(alleleKey, { ...(cache.get(alleleKey) ?? {}), [deviceId]: evidence });
}
