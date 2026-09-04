# Performance

Measurements on the current ARM development environment establish practical v0.1 expectations:

| Operation | Observed/target behavior |
| --- | --- |
| Exact ClinVar/COSMIC/dbNSFP tabix query | approximately 10 ms locally; target under 100 ms |
| Cached evaluation or bypass | target under 100 ms |
| GRCh37 `csq` model load and 10-record fixture | approximately 1.2 seconds and 200 MB |
| GRCh38 `csq` batch of 10,515 candidate alleles | approximately 4.3 seconds and 792 MB |

Results are cached per exact allele, device/version, and device-resource fingerprint. Variant Consequences sends a complete request batch to one `bcftools csq` process because parsing the Ensembl model dominates startup. Source browsing and track rendering use bounded indexed pages, marks, and density bins rather than transferring the complete VCF to the interface.

These are development measurements on Linux ARM64, not guarantees across storage devices, bcftools builds, Ensembl releases, or operating systems.
