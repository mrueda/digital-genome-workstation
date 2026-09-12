# Gene perturbation and candidate-correction pilot

This pilot exercises Mutation Generator, Genome Optimizer and Genome Morph
through the actual DGW MCP server. It explores lower predicted-impact allele
configurations as candidate corrections, not demonstrated functional rescue.
The public HG00103 exome supplies positions and genotypes; the randomized
alleles are artificial and are not findings about the donor.

## Design and results

Seeds **1–10** were fixed before inspecting results. BRCA2 was examined first:
four imported SNV positions, seven ALT copies, score 3.33 in every randomized
and minimized track, with no improving changes. This negative result is retained.
TTN was an exploratory follow-up using the same seeds, not a prespecified
independent validation cohort. It contained 52 SNV positions and 67 ALT copies.
Scores decreased from 40.43–42.11 to 34.69, with 11–14 positions changed.
All ten final TTN configurations remained distinct; equal scores do not mean
equal sequences or equal biological function.

For each gene, optimized seed 1 was the morph origin and optimized seed 2 the
target. This pair was fixed before comparing their differences. Morph seed
**20260912**, ordering `seeded_random`, and amounts **0, 25, 50, 75, 100%**
were used. Each amount started from a new copy of the origin, rather than
applying cumulative edits. This is one track-pair comparison, with one run per
amount, not five replicate trials; morph between-run variability was not tested.
TTN had 17 differing positions; 0, 5, 9, 13 and 17
were copied, respectively. Every intermediate scored 34.69. The 100% endpoint
matched the target's effective alleles, copy counts and phase state.

### What was optimized

- Uniform randomization replaces each existing ALT with one of the two bases
  different from both REF and the current ALT. It is not uniform sampling of
  whole genes or genomes. Copy counts and phase state are retained.
- Saturation minimization compares all three non-reference SNV bases at each
  selected position. REF is not a candidate in this mode. Equal scores retain
  the current allele; only strictly improving alternatives are applied.
- The score sums independently evaluated ALT-copy consequences. The worst
  predicted category per allele is mapped to HIGH=1, MODERATE=0.67, LOW=0.33,
  MODIFIER=0.10, with impact weight 1. Exact ClinVar Pathogenic/Likely pathogenic
  candidates are excluded. COSMIC does not contribute to this experiment.
- Prediction uses bcftools 1.24 `csq --local-csq` and Ensembl GRCh37 release 87.
  The project manifests and resource checksums identify the actual files.
- A second optimizer pass checked that no further improving edits remained.
  One-pass convergence is expected for this separable additive objective; it
  is not evidence about evolutionary speed, epistasis or biological fitness.
- The reported scores are optimizer objective totals, not Track Monitor
  source-relative deltas. This experiment did not run Track Monitor profiling.

For seed 1, independently rerunning the same predictor confirmed that TTN
2:179454394 (GRCh37, 1-based) changed from ALT C, predicted stop-gained, to
ALT G, predicted synonymous (REF A). At 2:179554305, ALT A to G changed
stop-gained to missense (REF C). The second example shows why lower predicted
impact is not proof of restored function. These are genomic-strand alleles;
TTN is on the reverse strand. Full transcript consequences are retained in
`TTN/consequence-check/changed-consequences.json`.

The position-by-position morph diagram is generated from these archived states
with `python3 manuscript/draw_morph_pilot.py`. Its SVG is
`manuscript/figures/figure-3-morph-positions.svg`; the corresponding 85 observed
cells are exported to `TTN/morph-positions.csv`. The script checks copied counts,
nested subsets and scores against the saved jobs. Cyan identifies the target
allele, not a biological benefit. The 35 identical positions are omitted from
the display but remain in the score.

## Reproduce

Run from the repository root with Rust, Python 3.11+, and the configured b37
resource bundle. The Python MCP runner uses POSIX pipe polling (Linux/macOS).
Use fresh output directories; the scripts deliberately refuse to overwrite
an experiment. Resource paths are local configuration, not portable defaults.

```bash
cargo build --release -p dgw-mcp
cargo run --release -p dgw-core --example create_gene_pilot -- \
  fixtures/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz \
  SRR1596639 config/local-hs37d5.development.json TTN /tmp/dgw-ttn-reproduction
python3 manuscript/convergence_pilot.py \
  /tmp/dgw-ttn-reproduction/pilot.dgw /tmp/dgw-ttn-reproduction/results
python3 manuscript/archive_convergence.py \
  /tmp/dgw-pilot-reproduction-archive /tmp/dgw-ttn-reproduction
python3 manuscript/inspect_pilot_consequences.py \
  /tmp/dgw-pilot-reproduction-archive/TTN \
  /tmp/dgw-pilot-reproduction-archive/TTN/consequence-check
```

Repeat the bootstrap and runner with BRCA2 and a different new directory to
reproduce the initial pilot. Pass both run directories to the archive script
to collect both genes. The bootstrap calls DGW core import; all subsequent
device operations use MCP. No independent optimizer is implemented here.

## Archived artifacts and caveats

The final clarified main Figure 2 is **positions × directed substitutions**,
generated by `python3 manuscript/draw_substitution_matrix.py`. It predicts all
156 non-reference candidate alleles using the recorded bcftools and GFF3, maps
the strongest consequence category using the same mapping as DGW, and verifies
all 20 archived track totals within 1e-8 before drawing. Colours are per-copy
score differences; overlaid counts are actual choices across the ten seeds,
not selection probabilities. REF-involving comparisons are explicitly outside
this saturation scope. Predictions and command are in `TTN/substitution-comparison/`;
all 624 cells are in `TTN/substitution-impact-matrix.csv`. This script refreshes
these derived outputs, not the original MCP experiment. Earlier figure variants
below are retained as supporting/exploratory artifacts rather than current main
Figure 2.

The superseded seed-by-position figure is generated with `python3 manuscript/draw_minimization_matrix.py`:
ten seeds × all 52 positions, with cyan denoting an actual ALT change and grey
an unchanged ALT relative to that seed's randomized track. Colour does not
encode effect magnitude. `TTN/minimization-allele-matrix.csv` preserves all 520
before/after allele pairs, including REF and coordinates. The earlier seed-1
variant/consequence table remains available as a supporting artifact.

Each gene directory contains the input manifest, seeds and binary fingerprint,
raw results, compressed MCP transcript, CSV tables and configuration-diversity
statistics. Resource SHA-256 values are in `resource-checksums.json`.
`script-checksums.json` records script bytes at the original archival step;
later script maintenance does not change those historical fingerprints.

The initial BRCA2 runner failed before editing because of a Python argument
name collision. The corrected complete run is stored under `results-v2` in its
temporary working directory; this is not a second biological trial. The archive
script accepts the standard `results` directory first, with `results-v2` as a
fallback for this retained run.

At the tested revision, raw bulk-optimizer `excludedPositions` also counts
positions already tied for the best score. Consequently, `excluded_positions`
and `unchanged_or_tied` in the raw CSV must not be interpreted as counts of
ClinVar exclusions and ties, respectively. The manuscript tables use measured
scores and changed-position counts instead. This reporting issue does not
change the generated edits, but needs a separate software fix.

The git commit in `settings.json` identifies the base revision; these pilot
scripts were uncommitted when run. Use the retained script/binary fingerprints
and the eventual commit containing these files alongside that revision.
UUIDs, timestamps, job timings and transcript polling counts can differ on a
rerun; compare effective allele states and numerical results, not transcript
bytes. Floating-point totals should be compared with tolerance (1e-8).
