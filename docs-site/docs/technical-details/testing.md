# Testing

Unit tests cover VCF inspection, annotated and unannotated inputs, deliberate INFO ignoring, phased and unphased genotypes, phased and unphased `1/2` multiallelic decomposition, complementary rendered GT slots, homozygous merging when two slots are edited to one ALT, edit limits, track duplication and divergence, read-only source protection, per-track bypass isolation, additive schema-1 project migration, sequence materialization, deterministic hashes, and per-device resource-specific cache keys. Optimizer tests cover source-bounded minimize/maximize proposals, live impact weighting, Saturation minimum/maximum candidate selection, incomplete live evidence, cross-chromosome selection, atomic two-copy position limits, ClinVar guard behavior, exclusions, and invalid requests. Large-project tests cover indexed query plans, 200-row pages, 500-mark track bounds, 256 density bins, symbolic selection limits, and atomic batches. Consolidation tests verify visual flattening, unchanged effective alleles, retained audit ancestry, inherited private baseline exclusions, and clean track-based VCF rendering with evidence/provenance sidecars. Frontend tests cover stable locus labels, sequence presentation, project naming, scoring-input state, variant navigation, stale-response protection helpers, and searching beyond the first 250 sample columns of a large cohort.

## Local real-stack acceptance test

Run both assembly profiles with:

```bash
make acceptance-all
```

This check requires the external resources registered by `config/local-hs37d5.development.json` and `config/local-hg38.development.json`, so it is a local release gate rather than a public CI job. Each run creates a fresh project under `/tmp` and prints its location. Use `make acceptance-local` for only the foundational project workflow or `make acceptance-devices` for only the device workflow.

To run one assembly:

```bash
make acceptance-grch37
make acceptance-grch38
```

The acceptance runner imports and normalizes the VCF, reconstructs both chromosome copies across a 61-base interval, evaluates one exact allele through all four Evidence sources, duplicates the active genome track, and applies a reversible restoration. It then saves workstation state, closes and reopens the `.dgw` package, verifies the active track, edit head, effective alleles and evidence cache, and exports regional FASTA and track-based BGZF/CSI VCF. The final checks cover the selected sample, record count, CSI index, evidence sidecar and provenance sidecar.

The device runner selects all synthetic variants across chromosomes, generates a deterministic 100% randomization, stores and applies it as one compound layer, and computes the same additive Track Profiler result used by the desktop host. It then evaluates all three non-reference ALT candidates per selected SNV, compares Saturation minimize and maximize, applies a strictly improving direction, and confirms that repeating that direction is a no-op. The completed profile result, compound edits and optimized VCF are checked again after reopening the project. A separate 10,000-position unit test verifies that a large compound layer remains one history block and that browser-facing variant pages remain capped at 200 records.

Use `fixtures/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz` and select `SRR1596639` to test a realistic public 1000 Genomes exome. It spans the autosomes and chromosome X and imports as 19,598 exact alleles after multiallelic decomposition. Its provenance and extraction command are recorded in `fixtures/README.md`; private samples are never fixtures. The device runner also verifies that rack configuration and immutable terminal run records survive reopening and Save Copy, and that the copy retains the optimized effective alleles.

Track Profiler has a reproducible local parallel benchmark. It creates one randomized track, warms the registered resources, runs the same four Evidence devices twice at 1, 2 and 4 threads, and fails if the scientific result changes. Indexed-resource batches use the same bounded pool, so this covers both resource- and variant-level parallelism:

```bash
BENCHMARK_DIR=$(mktemp -d /tmp/dgw-profile-benchmark.XXXXXX)
cargo run -p dgw-desktop --release --example profile_parallel_benchmark -- \
  fixtures/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz \
  SRR1596639 "$BENCHMARK_DIR/profile.dgw" \
  config/local-hs37d5.development.json
```

The pool is local to the desktop process. It parallelizes independent Evidence devices and 2,000-allele indexed-resource batches; it is not a service or persistent worker system. Variant Consequences remains one complete batch, and project mutations remain serial.

CI runs core/frontend tests and production builds. A separate Linux/macOS job compile-checks the Tauri shell; Linux installs the official GTK/WebKit prerequisites first. The local acceptance workflow adds the real reference, bcftools, Ensembl and indexed Evidence-resource boundary that public CI cannot reproduce without the external bundle.

## Browser interaction checks

Playwright runs the real React application shell at a 1280 × 720 desktop viewport. A browser-only mock replaces the Tauri command boundary. The suite verifies that the project purpose and starting actions remain visible, the project-template chooser is reachable, appearance settings persist across reloads, and the About dialog retains the author and license identity. It also opens a complete synthetic workspace, selects and clears visible alleles, checks selection Undo/Redo, opens a mutation block in the Allele Roll, and confirms that resetting Mutation Generator restores its controls without changing existing edits.

These checks detect DOM, accessibility-name, menu, persistence, and viewport regressions. They do not simulate project storage or biological computation and therefore do not replace the Rust suite, Tauri compile checks, or the local real-stack acceptance test.

```bash
npx playwright install chromium
npm run test:e2e
```

To use an existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_PATH` to its executable path.

The documentation images use the same synthetic interface state. Regenerate the setup, workspace and Allele Roll captures with:

```bash
npm run docs:screenshots
```

The generated PNG files are written directly to `docs-site/static/img`. They contain no patient data. Screenshot generation is kept separate from the regression suite so ordinary test runs do not rewrite tracked documentation assets.
