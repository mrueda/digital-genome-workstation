# Testing

Unit tests cover VCF inspection, phased and unphased genotypes, edit limits, track duplication and divergence, read-only source protection, per-track bypass isolation, older-project track migration, sequence materialization, deterministic hashes, SnpEff ANN parsing, and resource-specific cache keys. Optimizer tests cover source-bounded minimize/maximize proposals, additive impact weighting, candidate limits, exclusions, and invalid requests. Consolidation tests verify visual flattening, unchanged effective alleles, retained audit ancestry, inherited private baseline exclusions, and track-based VCF rendering. Frontend tests cover stable locus labels, sequence presentation, project naming, and searching beyond the first 250 sample columns of a large cohort.

## Local real-stack smoke test

```bash
cargo run -p dgw-core --example local_smoke -- \
  fixtures/braf-v600e.synthetic.vcf DGW_DEMO /tmp/dgw-braf-demo \
  config/local-hs37d5.development.json
```

The smoke test creates a project, reconstructs 61 reference bases, evaluates the exact allele through all four sources, restores it, verifies bypass, renders a BGZF/CSI VCF, and re-inspects the output.

Use `fixtures/1000G-HG00096.public.vcf.gz` and select `HG00096` to test the selected-sample result from a 2,504-sample cohort. It contains 35 public, phased 1000 Genomes records. Its provenance and extraction command are recorded in `fixtures/README.md`; private samples are never fixtures.

CI runs core/frontend tests and production builds. A separate Linux/macOS job compile-checks the Tauri shell; Linux installs the official GTK/WebKit prerequisites first.
