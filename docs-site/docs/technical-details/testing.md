# Testing

Unit tests cover VCF inspection, annotated and unannotated inputs, deliberate INFO ignoring, phased and unphased genotypes, phased and unphased `1/2` multiallelic decomposition, complementary rendered GT slots, homozygous merging when two slots are edited to one ALT, edit limits, track duplication and divergence, read-only source protection, per-track bypass isolation, additive schema-1 project migration, sequence materialization, deterministic hashes, and per-device resource-specific cache keys. Optimizer tests cover source-bounded minimize/maximize proposals, live impact weighting, Saturation minimum/maximum candidate selection, incomplete live evidence, cross-chromosome selection, atomic two-copy position limits, ClinVar guard behavior, exclusions, and invalid requests. Large-project tests cover indexed query plans, 200-row pages, 500-mark track bounds, 256 density bins, symbolic selection limits, and atomic batches. Consolidation tests verify visual flattening, unchanged effective alleles, retained audit ancestry, inherited private baseline exclusions, and clean track-based VCF rendering with evidence/provenance sidecars. Frontend tests cover stable locus labels, sequence presentation, project naming, scoring-input state, variant navigation, stale-response protection helpers, and searching beyond the first 250 sample columns of a large cohort.

## Local real-stack smoke test

```bash
cargo run -p dgw-core --example local_smoke -- \
  fixtures/braf-v600e.synthetic.vcf DGW_DEMO /tmp/dgw-braf-demo \
  config/local-hs37d5.development.json
```

The smoke test creates a project, reconstructs 61 reference bases, evaluates the exact allele through all four sources, restores it, verifies bypass, renders a BGZF/CSI VCF, and re-inspects the output.

Use `fixtures/1000G-HG00096.public.vcf.gz` and select `HG00096` to test the selected-sample result from a 2,504-sample cohort. It contains 35 public, phased 1000 Genomes records. Its provenance and extraction command are recorded in `fixtures/README.md`; private samples are never fixtures.

CI runs core/frontend tests and production builds. A separate Linux/macOS job compile-checks the Tauri shell; Linux installs the official GTK/WebKit prerequisites first.
