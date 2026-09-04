# Performance

Measurements on the current ARM development environment establish practical v0.1 expectations:

| Operation | Observed/target behavior |
| --- | --- |
| Exact ClinVar/COSMIC/dbNSFP tabix query | approximately 10 ms locally; target under 100 ms |
| Cached evaluation or bypass | target under 100 ms |
| GRCh37 `csq` model load and 10-record fixture | approximately 1.2 seconds and 200 MB |
| GRCh38 `csq` batch of 10,515 candidate alleles | approximately 4.3 seconds and 792 MB |
| HG00103 Track Profiler, 53,564 mutation copies | 111.2 seconds at 1 worker; 39.5 seconds with Auto's 5 workers |

Results are cached per exact allele, device/version, and device-resource fingerprint. Variant Consequences sends a complete request batch to one `bcftools csq` process because parsing the Ensembl model dominates startup. Source browsing and track rendering use bounded indexed pages, marks, and density bins rather than transferring the complete VCF to the interface.

Track Profiler uses one bounded in-process Rayon pool. The four Evidence resources may run concurrently, and indexed dbNSFP, ClinVar and COSMIC lookups partition exact alleles into 2,000-allele batches on that same pool. The configured worker limit therefore bounds both levels; it does not create a second pool. In the benchmark above, dbNSFP was the main bottleneck and improved from 108.2 seconds serially to 36.3 seconds at four workers. The complete five-worker result was 2.82 times faster than the serial control. Variant Consequences stays as one batch to avoid loading several copies of the transcript model. Auto detected six online processors and reserved one for the interface; oversubscribing eight workers was faster in an additional stress run but is not the representative setting.

These are development measurements on Linux ARM64, not guarantees across storage devices, bcftools builds, Ensembl releases, or operating systems.
