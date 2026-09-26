# Device guide

import useBaseUrl from '@docusaurus/useBaseUrl';

These screenshots show **DGW v0.1**, in light mode, using the synthetic GRCh37 example. They are native application captures with real local calculations, not mock results. Click an image to inspect it at full resolution.

| To… | Use |
| --- | --- |
| Generate seeded allele changes | [Mutation Generator](#mutation-generator) |
| Copy a fraction of another track's alleles | [Genome Morph](#genome-morph) |
| Inspect transcript predictions for selected positions | [Consequence Predictor](#consequence-predictor) |
| Search for lower or higher predicted-impact scores | [Genome Optimizer](#genome-optimizer) |
| Compare the source and current track | [Track Compare](#track-compare) |
| Read the aggregate change across active mutations | [Track Monitor](#track-monitor) |
| Inspect one exact allele | [Evidence](#evidence) |

Add a device through **Create → Add Device** or the Rack's **Add device** button. Expand it with the diagonal arrows; **Back to tracks** returns to the workspace. Reset restores device controls, not the edits it already made. Use Undo to reverse an editing action.

:::note[Scope and Bypass]
Mutation Generator, Genome Optimizer, Consequence Predictor reports and Track Compare use the selection made in Track view. Genome Morph instead uses differences between the selected track and its target. Only the database Evidence devices—ClinVar and COSMIC—have Bypass. It excludes their evidence from evaluation without changing DNA.
:::

## Mutation Generator

Choose the amount, seed and substitution pattern, then **Generate mutations**. The result is applied to the selected track: small runs add blocks and large runs add a compact layer. There is no separate Preview/Apply step. The same seed and inputs reproduce the same perturbation.

<a href={useBaseUrl('/img/devices/generator.png')}><img src={useBaseUrl('/img/devices/generator.png')} alt="Mutation Generator after applying eight reversible blocks at seven selected positions, Uniform pattern and seed 42" loading="lazy" /></a>

Here, seven selected positions produced eight copy-level blocks. A position and an allele copy are different counting units.

## Genome Morph

Choose a target track and an amount, then **Apply morph**. Only the selected track changes; the target remains intact. Each run uses the differences that remain at that moment, not the original starting state.

<a href={useBaseUrl('/img/devices/morph.png')}><img src={useBaseUrl('/img/devices/morph.png')} alt="Genome Morph after copying four positions toward Source genome at 50 percent, using genomic order" loading="lazy" /></a>

In this example, morphing the randomized track 50% toward Source genome copied four positions. Three loci still differ, as shown below in Track Compare.

## Consequence Predictor

Applied Consequence Predictor already supplies automatic predictions for the focused allele and Track Monitor. You do **not** need to create a report first. Open **Selection report**, then **Create report**, when you want a searchable, filterable transcript table for the current ALTs at all selected loci—including unchanged loci. Existing compatible allele results can be reused.

<a href={useBaseUrl('/img/devices/predictor.png')}><img src={useBaseUrl('/img/devices/predictor.png')} alt="Consequence Predictor report for seven selected loci with consequence and impact filter chips and transcript details" loading="lazy" /></a>

Use **Consequence** and **Impact** chips to filter the saved report, and **Transcripts** to inspect the records at a locus. This predicts each allele independently; it does not predict a combined effect across the selection. Multiple impact classes can belong to different transcripts.

## Genome Optimizer

Select positions, choose the mode and direction, review the scoring weights and maximum changes, then run. **Saturation scan** compares all three non-reference SNV bases at each eligible selected position. **Conservative** mode considers the source ALT and REF. See [Scoring and Evidence Methods](../technical-details/scoring-methods.md) for the objective and eligibility rules.

<a href={useBaseUrl('/img/devices/optimizer.png')}><img src={useBaseUrl('/img/devices/optimizer.png')} alt="Genome Optimizer configured for saturation minimization with Impact weight 70 and at most five changed positions" loading="lazy" /></a>

This image shows settings, not an optimization result. Minimize and Maximize refer to the displayed proxy score, not health or disease. Consolidation records the edited state; it is not required to inspect active edits or evaluate them.

## Track Compare

All three views use the Track-view selection and compare **Source → Current**. They examine the applied track state, including compact bulk layers; they do not require consolidation.

### DNA changes

Read the actual source and current alleles. **Differences only** hides matching loci; **Find locus** searches a coordinate or interval within the selection. Click a locus to inspect its evidence.

<a href={useBaseUrl('/img/devices/compare.png')}><img src={useBaseUrl('/img/devices/compare.png')} alt="Track Compare DNA changes showing the three remaining differing loci after a 50 percent morph" loading="lazy" /></a>

### Genome view

Bars summarize the percentage of selected loci that differ in each interval, on a fixed 0–100% scale. Colour distinguishes ALT sequence, ALT-copy count and copy/phase changes. Grey marks matching genotypes; empty intervals have no selected loci. Click a bin or drag across a chromosome strip to zoom. At close range, individual alleles replace the summary.

<a href={useBaseUrl('/img/devices/genome.png')}><img src={useBaseUrl('/img/devices/genome.png')} alt="Genome view with three changed selected loci on chromosome 7 and no selected loci on chromosome 17" loading="lazy" /></a>

### Consequence changes

Choose **Compare consequences** to evaluate source/current predictions at changed loci in the selection. This can require a background calculation, unlike the DNA views. Results distinguish different predictions, matching predictions, missing evidence and REF restorations.

<a href={useBaseUrl('/img/devices/compare-consequences.png')}><img src={useBaseUrl('/img/devices/compare-consequences.png')} alt="Consequence comparison: two loci with different predictions, one with matching predictions, no missing evidence or REF restorations" loading="lazy" /></a>

Matching predictions do not prove equal biological function. These are locus-level comparisons, not a second Track Monitor score.

## Track Monitor

Track Monitor is a workspace panel, not a Rack device. Track Profiler evaluates active mutations automatically when the selected track has no compatible profile. Wait for completion and check coverage before interpreting the numbers.

<a href={useBaseUrl('/img/devices/monitor.png')}><img src={useBaseUrl('/img/devices/monitor.png')} alt="Completed Track Monitor: 12 evaluated mutations, mean impact delta +0.0842 and total delta +1.01" width="360" loading="lazy" /></a>

The total sums source-relative, independent-allele impact changes. The mean divides that total by the number of evaluated mutations. Here the 12 evaluated operations include eight randomizer blocks and four morph changes; this is not the three-locus DNA-difference count. Neither number is a disease probability. See the [formulas](../technical-details/scoring-methods.md).

## Evidence

The Evidence panel follows one focused allele. It separates **computed transcript predictions** from **exact database matches**. Choosing another transcript or database record changes the displayed detail, not the DNA or Monitor score. A missing ClinVar/COSMIC match does not mean benign. COSMIC is optional and uses the user's local resource.

<a href={useBaseUrl('/img/devices/evidence.png')}><img src={useBaseUrl('/img/devices/evidence.png')} alt="Focused-allele Evidence panel with bcftools-derived consequence labels, gene and impact class" width="420" loading="lazy" /></a>

## Allele Roll

Allele Roll is an editor rather than a Rack device. Open a candidate-track variant, then use the **Allele Roll** view. A/C/G/T rows align with forward-strand FASTA; muted columns are reference context, not additional editable VCF calls. Drag a filled base vertically or click a destination cell, then apply the proposal in the Mutation editor.

<a href={useBaseUrl('/img/devices/allele-roll.png')}><img src={useBaseUrl('/img/devices/allele-roll.png')} alt="FASTA-aligned Allele Roll with four base rows, variant-position markers and chromosome-copy legend" loading="lazy" /></a>

### Reproduce these views

Open a fresh GRCh37 Allele Editing example. On **Working track**, select the seven visible chromosome-7 loci, generate Uniform mutations with Amount 100% and Seed 42, then morph 50% toward **Source genome**, using Genomic order. Select the seven visible loci again for the reports. The displayed outcomes depend on the resource versions; this screenshot set uses Ensembl 87 and ClinVar 20250312. It is an interface demonstration, separate from the manuscript's TTN/BRCA2 pilot.
