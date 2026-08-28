# Evaluation Engine

Within the DGW rack model, SnpEff is an **analysis device**. dbNSFP, ClinVar, and COSMIC are **evidence devices**. Their current implementations are built-in adapters, but they already return structured results through a host-owned boundary rather than writing project state themselves.

Device behavior and biological resources are separate. The analysis/evidence adapters are code; the registered SnpEff model and database snapshots belong to the resource pack. See [Device API and Resource Packs](device-api.md).

## Persistent SnpEff

SnpEff starts with a minimal VCF stream on stdin. Each request receives a unique temporary VCF ID; the stdout reader discards headers and correlates the returned record by that ID. One worker serializes requests for one resource-bundle fingerprint. A timeout or process failure causes one restart attempt.

This avoids the approximately 3 GB model reload for every edit. On the current ARM development machine, the cold load is about 8–12 seconds and a warm record returns well below one second.

## Exact indexed lookup

tabix queries the edited position in each database, after which DGW verifies contig, position, REF, and ALT itself. ClinVar and COSMIC INFO fields are parsed into structured records. The dbNSFP header supplies names for its tab-delimited score columns.

## Cache contract

The cache key hashes:

```text
dgw-eval-v1 | assembly | contig | position | REF | ALT | resource-bundle fingerprint
```

Found and exact no-match results are durable. Errors and unavailable resources are returned to the interface but not cached, so recovery does not require manual invalidation.

The UI uses a request generation counter, ensuring that a result from an older selection cannot replace evidence for a newly selected allele.

The host, not a device, persists evaluation results and chooses cache identities. A future external evidence device must use the same structured status and provenance contract; direct cache or project-database mutation is outside the Device API.
