# Digital Genome Workstation

**What would change if this sample had a different allele?** DGW lets you edit genome variants, inspect predicted consequences and database evidence, and compare alternatives without changing the source VCF.

Its organization comes from the mature digital audio workstation (DAW) ecosystem: keep a source, duplicate tracks, apply reversible edits through devices, and compare the results. You do not need to know music software to use it.

[Install DGW](usage/installation.md) · [Try an example](usage/quickstart.md) · [DGW and music workstations](reference/faq.md)

![DGW interface showing genome tracks above the Device Rack, with navigation on the left and evidence and monitoring on the right](/img/dgw-workspace.png)

*Current interface, captured with controlled demonstration data. These screenshots illustrate the controls, not a validated biological result.*

## One source, several alternatives

DGW is an **editing workstation, not a new variant-effect predictor or prediction atlas**. Resources such as AlphaGenome Atlas provide predictions; DGW keeps editable scenarios, the operations that produced them and their evaluated results. See [how these roles differ](reference/faq.md#how-does-dgw-differ-from-alphagenome-atlas). AlphaGenome integration is not currently implemented.

The imported sample becomes a read-only **source track**. Duplicate it to make an editable scenario. Edits belong to that track; the original VCF stays untouched.

![Workflow from sample import through duplication, editing, evaluation and comparison to saving or export](/img/dgw-workstation-workflow.svg)

A track contains both chromosome copies. **A/B does not mean maternal/paternal**, and unphased alleles remain copy-unknown. Several edits can coexist on a track without implying that DGW predicts their combined biological effect.

## Find your way around

| Area | Use it to… |
| --- | --- |
| Source Variants, on the left | Find an input allele or navigate between chromosomes. |
| Genome tracks, in the centre | Duplicate a scenario, select positions and see where edits lie. |
| Allele editor, below the tracks | Stage a base change in Allele Roll or inspect reconstructed sequence. |
| Device Rack, below the tracks | Configure tools on the selected track. **Show devices** returns here from the editor. |
| Evidence Inspector | Read predictions and exact database matches for the selected allele. |
| Track Monitor | Compare aggregate independent-allele signals with the source. |
| Genome Transport | Step through alleles for review. Play navigates; it does not mutate. |

See [Focused Track Workspace](usage/focused-workspace.md) for selection, zoom and navigation.

## Devices have different jobs

| Role | Built-in examples | What they do |
| --- | --- | --- |
| Edit | Mutation Generator | Propose reversible allele changes. |
| Evidence | ClinVar, COSMIC | Retrieve reported variant records and submitted clinical interpretations. |
| Analyze | Consequence Predictor, Genome Optimizer | Predict transcript effects or propose changes under a named, bounded scoring model. |
| Visualize | Track Compare | Display available results without editing or scoring. |

Use **Create → Add Device** to browse devices. The rack shows those applied to the selected track, not every available tool. Devices are built into DGW today; third-party plug-in installation is not yet supported. Grouping by role does not imply an audio-style signal chain.

The experimental Optimizer offers **Conservative** mode (REF restoration or original-source ALT reintroduction) and **Saturation scan** (comparison of all three non-REF bases at selected imported SNV positions). Read [the optimizer rules](usage/edit-and-compare.md#optimizer-behavior) before interpreting its output.

:::caution[A lower score is not a healthier genome]
Scores sum independently evaluated allele-copy contributions. They do not model interactions, combined transcript/protein effects, penetrance or disease probability. REF is a reference sequence, not a benign classification. Missing database evidence is not evidence of safety.
:::

## What you can load and keep

- **Input:** one sample from a VCF, including multiallelic calls and phased or unphased genotypes. DGW keeps strict `FILTER=PASS` records and normalizes a project copy. Imported INFO annotations are ignored.
- **Resources:** supplied profiles for GRCh37 and GRCh38, installed separately from the app. Current small-variant support does not include BAM/CRAM, read pileups or general structural-variant editing.
- **Output:** reopenable `.dgw` projects, single-sample VCF and focused-region FASTA. Consolidation is optional and retains recorded ancestry.

The model is not inherently human-specific, but the supplied resources are human. Large projects use paged navigation, density views and background jobs rather than drawing every allele at once.

Continue with [Quick Start](usage/quickstart.md), [input requirements](usage/input-vcf.md), or [scoring and evidence methods](technical-details/scoring-methods.md). DGW is research software, not a diagnostic tool.
