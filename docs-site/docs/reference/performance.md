# Performance

Measurements on the current ARM development environment establish practical v0.1 expectations:

| Operation | Observed/target behavior |
| --- | --- |
| Exact ClinVar/COSMIC/dbNSFP tabix query | approximately 10 ms locally; target under 100 ms |
| Cached evaluation or bypass | target under 100 ms |
| Warm SnpEff record | target under 1 second at p95 |
| Cold SnpEff model load | approximately 8–12 seconds; target under 15 seconds |
| SnpEff resident memory | approximately 3 GB |

The interface does not block while the evaluator starts. Results are cached per allele and resource bundle. One serialized worker intentionally trades parallel annotation throughput for predictable memory and ordering in the single-user desktop workflow.

These are development measurements, not guarantees across storage devices, Java runtimes, database releases, or macOS systems.

