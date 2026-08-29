# Evaluation Engine

Within the user-facing DGW rack model, SnpEff, dbNSFP, ClinVar, and COSMIC are **Evidence** devices. They report different kinds of allele-level evidence, including predicted transcript consequences and computational scores. Their current implementations are built-in adapters, but they already return structured results through a host-owned boundary rather than writing project state themselves.

Device behavior and biological resources are separate. The analysis/evidence adapters are code; the registered SnpEff model and database snapshots belong to the resource pack. See [Device API and Resource Packs](device-api.md).

Imported VCF annotations never enter this path. The engine receives an exact normalized `assembly/contig/POS/REF/ALT` key and evaluates that allele with the resources registered for the project. This is why an edited ALT can be evaluated even when it never appeared in the input VCF.

## Persistent SnpEff

SnpEff starts with a minimal VCF stream on stdin. Each request receives a unique temporary VCF ID; the stdout reader discards headers and correlates the returned record by that ID. One worker serializes requests for one resource-bundle fingerprint. A timeout or process failure causes one restart attempt.

This avoids reloading the model for every edit. Cold and warm timings depend on the machine and the selected SnpEff dataset.

## Exact indexed lookup

tabix queries the edited position in each database, after which DGW verifies contig, position, REF, and ALT itself. ClinVar and COSMIC INFO fields are parsed into structured records. The dbNSFP header supplies names for its tab-delimited score columns.

## Cache contract

Each device has its own cache identity. The key includes:

```text
dgw-eval-v1 | device/version | assembly | contig | position | REF | ALT | device-resource fingerprint
```

Found and exact no-match results are durable. Errors and unavailable resources are returned to the interface but not cached, so recovery does not require manual invalidation. Adding or repairing one optional resource does not invalidate unrelated device results.

Selecting an allele automatically starts the active Evidence devices after a short debounce. The UI shows stable cached results first, requests only missing device results, deduplicates in-flight requests, and uses a request generation counter so an older response cannot replace evidence for a newer selection. The manual refresh action remains available.

The host, not a device, persists evaluation results and chooses cache identities. A future external evidence device must use the same structured status and provenance contract; direct cache or project-database mutation is outside the Device API.

## Optimizer use

No optimizer mode falls back to imported `ANN`, `CLNSIG`, or another source INFO field. Conservative uses normalized allele identity and counts selected non-reference copies without Evidence-device input. Saturation uses the same typed live evidence boundary as the allele inspector and evaluates three non-REF candidates per selected canonical SNV, with a hard limit of 100 selected positions. A required SnpEff or ClinVar-guard failure aborts the run before edits are applied.
