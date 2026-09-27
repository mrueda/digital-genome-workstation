# Reproduce the paper examples

import useBaseUrl from '@docusaurus/useBaseUrl';

What happens when you randomize a gene's imported variants, minimize their predicted impact, then morph between the resulting tracks? These experiments use **Mutation Generator, Genome Optimizer and Genome Morph** through DGW's MCP interface—the same core operations used by the desktop app.

You can read the results below without setting up MCP. To run them, follow [Reproduce the experiments](#reproduce-the-experiments).

:::note[What the input represents]
The public HG00103 exome supplies the positions and genotypes. The randomized alleles are artificial, not findings about the donor. Only SNVs present in this VCF are examined, not every base in either gene.
:::

## 1. Randomize, then minimize

**Question:** can different starting alleles reach the same predicted-impact score?

For each gene, ten fresh source-track copies were randomized with seeds **1–10**. Each run then compared the three non-reference bases at every selected position and applied only strictly lower-scoring alternatives. A second optimizer pass checked for further improvements.

| Gene | Imported SNV positions | ALT copies | Randomized score | Minimized score | Positions changed per run |
| --- | ---: | ---: | ---: | ---: | ---: |
| BRCA2 | 4 | 7 | 3.33 | 3.33 | 0 |
| TTN | 52 | 67 | 40.43–42.11 | 34.69 | 11–14 |

These are **ten seeded runs per gene**, not biological replicates. BRCA2 was tested first; TTN was an exploratory follow-up. All ten minimized TTN tracks remained different, despite sharing the same score. No further improving edits were found on the second pass.

### Which substitutions changed the score?

<figure>
  <a href={useBaseUrl('/img/paper/figure-2-substitution-matrix.svg')}><img src={useBaseUrl('/img/paper/figure-2-substitution-matrix.svg')} alt="TTN matrix: 52 genomic positions by 12 directed base substitutions, with predicted-impact differences and counts of choices across ten seeded minimization runs" loading="lazy" /></a>
  <figcaption>Paper Figure 2. Click to open the vector figure at full size.</figcaption>
</figure>

- **Rows:** the 52 imported TTN positions, in GRCh37 coordinates (1-based).
- **Columns:** directed changes, such as C → G.
- **Colour:** change in predicted impact per ALT copy. Cyan is lower, orange higher, and neutral equal.
- **Numbers:** how many of the ten runs chose that substitution. An unnumbered scored cell was never chosen; a crossed cell involves REF and is outside this saturation comparison.

At 2:179454394, for example, seed 1 changed ALT C (predicted stop-gained) to G (predicted synonymous). At 2:179554305, A → G changed stop-gained to missense. The latter illustrates why a lower score is not proof of restored function. These are genomic-strand bases; TTN is on the reverse strand.

### What was minimized?

The pilot summed the strongest predicted impact category for each ALT copy: **HIGH = 1, MODERATE = 0.67, LOW = 0.33, MODIFIER = 0.10**, with impact weight **1**. See [scoring methods](../technical-details/scoring-methods.md) for the formulas.

REF was not a candidate in saturation mode. Exact ClinVar Pathogenic/Likely pathogenic candidates were ineligible, and equal-scoring alternatives retained the current ALT. COSMIC did not contribute.

:::tip[Reading the result]
These are **optimizer totals**, not Track Monitor source-relative deltas. The pilot did not run Track Monitor profiling. With this additive objective and fixed candidate sets, a single pass can find the best eligible choice independently at each position. This is not a model of evolutionary time, interactions between variants or biological fitness.
:::

## 2. Morph between different tracks with the same score

**Question:** can DNA change while the predicted-impact total stays the same?

The minimized TTN tracks from seeds 1 and 2 differed at **17 positions**. Using seed **20260912** and seeded-random ordering, Genome Morph copied increasing fractions of the target into fresh copies of the origin.

<figure>
  <a href={useBaseUrl('/img/paper/figure-3-morph-positions.svg')}><img src={useBaseUrl('/img/paper/figure-3-morph-positions.svg')} alt="Five TTN morph states showing the actual ALT at each of 17 differing positions; 0, 5, 9, 13 and 17 target positions are copied, while every state scores 34.69" loading="lazy" /></a>
  <figcaption>Paper Figure 3. Cyan marks a copied target allele, not a biological improvement. Click to enlarge.</figcaption>
</figure>

At **25%**, five positions were copied; at **100%**, all 17 matched the target. Each amount started from a fresh origin copy—these were not successive edits. There was **one run per amount**, not repeated morph trials.

All five states scored **34.69** because the differing alleles were tied at each position under this scoring model. The other 35 positions are omitted from the figure but included in the total. Equal endpoint totals would not, by themselves, guarantee an unchanged score during morphing in another example.

In the app, use **Track Compare → DNA changes** to inspect the actual allele differences. A score alone cannot tell you whether two tracks contain the same DNA.

## Reproduce the experiments

The scripts and archived results are in the repository's [manuscript directory](https://github.com/mrueda/digital-genome-workstation/tree/main/manuscript). Start with the [MCP setup guide](../technical-details/mcp-server.md) and a source checkout. The runner uses Python 3.11+ and POSIX pipes (Linux/macOS); no LLM or agent subscription is required.

| Setting | Recorded value |
| --- | --- |
| Input | `fixtures/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz`, sample `SRR1596639` |
| Reference and transcripts | hs37d5; Ensembl GRCh37 release 87 GFF3 |
| Predictor | bcftools 1.24, local consequence mode |
| ClinVar | `clinvar_20250312.vcf.gz` |
| Randomizer | Uniform; amount 100%; seeds 1–10; maximum 1,000 positions |
| Optimizer | Saturation; minimize; impact weight 1; maximum 1,000 positions and 1,000 changes |
| Morph | Seeded-random order; seed 20260912; amounts 0, 25, 50, 75, 100% |
| Workers | 2 |

The limits exceed both gene selections. Uniform randomization replaces each existing ALT with one of the two bases different from both REF and the current ALT, retaining copy counts and phase state.

Run from the repository root. Replace `/path/to/b37-bundle.json` with your configured resource-bundle manifest. **Exact reproduction requires the recorded resource versions**, not just any GRCh37 installation; checksums are retained in the archive. Use a new output directory—the scripts refuse to overwrite an experiment.

```bash
cargo build --release -p dgw-mcp

cargo run --release -p dgw-core --example create_gene_pilot -- \
  fixtures/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz \
  SRR1596639 /path/to/b37-bundle.json TTN /tmp/dgw-ttn-reproduction

python3 manuscript/convergence_pilot.py \
  /tmp/dgw-ttn-reproduction/pilot.dgw \
  /tmp/dgw-ttn-reproduction/results
```

Repeat the last two commands with `BRCA2` instead of `TTN` and a new directory such as `/tmp/dgw-brca2-reproduction`. The bootstrap imports through DGW core. The Python runner calls MCP preview, apply and job operations; it does not implement its own optimizer. MCP retains explicit preview/apply steps even though the desktop editing devices present a single action.

### Check your results

Compare effective alleles and scores with the archived [pilot results](https://github.com/mrueda/digital-genome-workstation/tree/main/manuscript/pilot-results), using a numerical tolerance of **10⁻⁸**. UUIDs, timestamps and job polling counts can differ.

The archive includes CSV summaries, fixed seeds, raw results, MCP transcripts and resource checksums. Its [README](https://github.com/mrueda/digital-genome-workstation/blob/main/manuscript/pilot-results/README.md) documents archiving, independent consequence checks and figure generation. Historical exclusion/tie counters have a documented reporting limitation; use the checked scores and actual changed-position counts shown here.

These examples demonstrate reproducible editing and candidate comparison. They do not demonstrate functional rescue, disease prevention or combined effects of nearby variants.
