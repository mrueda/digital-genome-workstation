# Performance

Measurements on the current ARM development environment establish practical v0.1 expectations:

| Operation | Observed/target behavior |
| --- | --- |
| Exact ClinVar/COSMIC/dbNSFP tabix query | approximately 10 ms locally; target under 100 ms |
| Cached evaluation or bypass | target under 100 ms |
| Warm SnpEff record | target under 1 second at p95 |
| Cold SnpEff model load | approximately 8–12 seconds; target under 15 seconds |
| SnpEff resident memory | approximately 3 GB |

The interface does not block while the evaluator starts. Results are cached per exact allele, device/version, and device-resource fingerprint. The SnpEff worker is serialized to keep memory and ordering predictable in the single-user desktop workflow. Source browsing and track rendering use bounded indexed pages, marks, and density bins rather than transferring the complete VCF to the interface.

These are development measurements, not guarantees across storage devices, Java runtimes, database releases, or macOS systems.
