# Performance

Measurements on the current ARM development environment establish practical v0.1 expectations:

| Operation | Observed/target behavior |
| --- | --- |
| Exact ClinVar/COSMIC tabix query | approximately 10 ms locally; target under 100 ms |
| Cached evaluation or bypass | target under 100 ms |
| GRCh37 `csq` model load and 10-record fixture | approximately 1.2 seconds and 200 MB |
| GRCh38 `csq` batch of 10,515 candidate alleles | approximately 4.3 seconds and 792 MB |
| HG00103 Track Profiler, 53,564 mutation copies | 111.2 seconds at 1 worker; 39.5 seconds with Auto's 5 workers |

Results are cached per exact allele, device/version, and device-resource fingerprint. Variant Consequences sends a complete request batch to one `bcftools csq` process because parsing the Ensembl model dominates startup. Source browsing and track rendering use bounded indexed pages, marks, and density bins rather than transferring the complete VCF to the interface.

These historical timings do not represent the current resource set. Rebenchmark before drawing performance conclusions.

Track Profiler uses one bounded in-process Rayon pool. The three Evidence resources may run concurrently, and indexed ClinVar and COSMIC lookups partition exact alleles into 2,000-allele batches on that same pool. The configured worker limit therefore bounds both levels; it does not create a second pool. The historical benchmark above included the now-removed dbNSFP device, which was the main bottleneck and improved from 108.2 seconds serially to 36.3 seconds at four workers. The complete five-worker result was 2.82 times faster than the serial control. Variant Consequences stays as one batch to avoid loading several copies of the transcript model. Auto detected six online processors and reserved one for the interface; oversubscribing eight workers was faster in an additional stress run but is not the representative setting.

These are development measurements on Linux ARM64, not guarantees across storage devices, bcftools builds, Ensembl releases, or operating systems.

## Tool-package comparison

On 5 September 2026, the proposed Linux ARM64 tool package was compared with the development installation using the public HG00103 exome fixture (19,578 input records). Both used bcftools/HTSlib 1.24 and the same GRCh37 reference and Ensembl model. The benchmark filters PASS records, normalizes with strict REF checking, then runs independent `csq` predictions. Timings below are medians of three repetitions, alternating tool order.

| Build | Normalization | Consequence prediction |
| --- | ---: | ---: |
| Development installation | 0.639 s | 5.149 s |
| Initial package, without libdeflate | 1.340 s | 9.269 s |
| Development installation, second comparison | 0.633 s | 5.050 s |
| Diagnostic build with libdeflate restored | 0.628 s | 5.044 s |

Alleles, genotypes and BCSQ values matched exactly in both comparisons. Restoring libdeflate recovered performance on this workload. The diagnostic build uses the system library; it is not a distributable package.

The subsequent revision-2 package includes static libdeflate 1.26 and passed native tests on all five targets. Its Linux ARM64 archive was benchmarked separately with the same procedure: normalization 0.646 s versus 0.666 s for the development installation; consequence prediction 5.429 s versus 5.360 s. All allele/genotype/BCSQ rows matched exactly across three repetitions. This removes the earlier regression on this fixture; it does not establish performance on every platform or workload.

Run the comparison with `python3 scripts/benchmark-tool-package.py /path/to/package/bin`. The script defaults to the development GRCh37 descriptor and public exome fixture; use `--bundle` and `--fixture` to supply alternatives. This measures command-line tools, not application rendering, saturation search or complete Track Profiler jobs. Filesystem cache state and other running processes can affect the results.
