# Evaluation Engine

Consequence Predictor is an **Analyze** device that computes independent transcript effects. ClinVar and COSMIC are **Evidence** devices that retrieve exact database records. They share an allele-evaluation service, but predictions remain distinct from database evidence. These built-in adapters return structured results through a host-owned boundary rather than writing project state themselves.

Device behavior and biological resources are separate. The adapters are code; the registered Ensembl GFF3 and database snapshots belong to the resource pack. See [Device API and Resource Packs](device-api.md).

Imported VCF annotations never enter this path. The engine receives an exact normalized `assembly/contig/POS/REF/ALT` key and evaluates that allele with the resources registered for the project. This is why an edited ALT can be evaluated even when it never appeared in the input VCF.

## Batched transcript consequences

Consequence Predictor writes the requested exact alleles to a temporary VCF and invokes the project's pinned `bcftools csq` with `--local-csq --ncsq 64`, the reference FASTA, and the assembly-matched Ensembl GFF3. Stable temporary IDs correlate output records with requests. `--local-csq` deliberately evaluates each VCF record independently so Saturation candidates remain comparable.

The complete request is sent as one batch because loading the Ensembl model dominates startup. `BCSQ` Sequence Ontology terms are mapped to DGW's four impact classes. When `csq` reports no overlapping transcript feature, DGW emits an explicit `no_transcript_feature` MODIFIER record; it does not describe this as a database match.

## Exact indexed lookup

tabix queries the edited position in each database, after which DGW verifies contig, position, REF, and ALT itself. ClinVar and COSMIC INFO fields are parsed into structured records.

## Cache contract

Each device has its own cache identity. The key includes:

```text
dgw-eval-v1 | device/version | assembly | contig | position | REF | ALT | device-resource fingerprint
```

Found and exact no-match results are durable. Errors and unavailable resources are returned to the interface but not cached, so recovery does not require manual invalidation. Adding or repairing one optional resource does not invalidate unrelated device results.

Selecting an allele automatically requests predictions from the applied Consequence Predictor and records from enabled database devices after a short debounce. The UI shows stable cached results first, requests only missing device results, deduplicates in-flight requests, and uses a request generation counter so an older response cannot replace evidence for a newer selection. The manual refresh action remains available.

The host, not a device, persists evaluation results and chooses cache identities. A future external evidence device must use the same structured status and provenance contract; direct cache or project-database mutation is outside the Device API.

## Optimizer use

No optimizer mode falls back to imported `ANN`, `CLNSIG`, or another source INFO field. Conservative counts selected non-reference copies without consequence scoring; maximize also screens source ALTs with ClinVar before reintroducing them. Saturation uses the same typed evaluation boundary as the allele inspector and evaluates three non-REF candidates per selected canonical SNV. Runs above 100 selected positions use a persistent background job, send the accepted candidate scope through one consequence batch, query ClinVar in bounded region batches, and retain only the winning edit data needed for the compound layer. The configurable run limit has an experimental 100,000-position ceiling. A required Consequence Predictor or ClinVar-guard failure aborts the run before edits are applied.

See [Scoring and Evidence Methods](scoring-methods.md) for the fields, equations, selection rules, and reporting requirements.
