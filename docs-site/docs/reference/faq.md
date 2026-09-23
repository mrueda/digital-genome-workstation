# Frequently Asked Questions

## How does DGW differ from AlphaGenome Atlas?

[AlphaGenome Atlas](https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/)
provides precomputed predictions of variant effects, with tools for exploring and querying them.
AlphaGenome is the underlying prediction model; Atlas makes its precomputed results accessible.

DGW provides the **editing experiment**: load a sample VCF, duplicate tracks,
make or generate reversible changes, compare alternatives and save or export the result.
Mutation Generator, Genome Optimizer and Genome Morph operate on those track states.
DGW does not introduce a new prediction model or claim better predictive accuracy.
Its current consequence device uses bcftools csq; it does not use AlphaGenome or Atlas.

The roles could complement each other. A future Evidence device could retrieve Atlas
results through its [API](https://www.alphagenomedocs.com/api/atlas.html), or query
suitable downloadable data where available and permitted. That would require matching
assemblies and exact alleles, recording resource versions, handling missing results,
and checking access terms. Remote queries would also need explicit user control over
sending variant information outside the computer.

Using those predictions in Genome Optimizer would require a separately defined and
tested objective, not silently substituting them into the current impact-category score.
Independent variant scores would still not establish the combined effect of several
edits. **This is a possible future integration, not a supported device.**

## Why is DGW inspired by digital audio workstations?

Music production has a mature way of working: try a change, compare alternatives,
temporarily disable an effect, and keep the original. DGW brings that approach to
genome-variant editing. The connection is about how you work, not just how the app looks.

| Familiar DAW concept | In DGW | What it lets you do |
| --- | --- | --- |
| Tracks and alternative takes | Genome tracks | Keep different versions of the same sample alongside a read-only source. Each track is a genome scenario, not one chromosome copy. |
| Piano roll | Allele Roll | Inspect and stage base changes in A/C/G/T lanes at imported SNV positions. The horizontal axis is genomic position, not time. |
| Selecting notes or events | Variant selection | Click individual alleles, drag a selection box, or select across the track before applying a batch operation. |
| Timeline zoom and track height | Genomic zoom, panning and resizable tracks | Move between a region overview and individual alleles, or make room by minimizing tracks. Broad views do not draw every allele separately. |
| Non-destructive edits | Mutation blocks and bulk layers | Keep changes visible and reversible without rewriting the source VCF. |
| Undo and redo | Workstation action history | Undo supported actions such as selection, track renaming and applied mutation batches. This session history is separate from the saved ancestry of genome edits. |
| Bypass | Edit and device bypass | Compare a track with and without an edit, or disable a device's contribution where the selected model uses it. Bypass does not delete source data. |
| Effects and instrument rack | Device Rack | Keep editing, evidence, analysis and visualization tools together on a track. |
| Selection-based MIDI generators | Mutation Generator | Generate changes for selected positions using controls such as amount, seed and substitution pattern, rather than editing each allele manually. |
| Output meter | Track Monitor | See evaluated changes relative to the source, including score direction and evaluation coverage. It measures a defined model output, not sound or health. |
| Transport controls | Variant review controls | Step through alleles or advance through them automatically for inspection. Playback does not simulate evolution or generate mutations. |
| Consolidate or bounce | Consolidation and export | Consolidation makes the effective track its new visual baseline while retaining ancestry. Export writes a VCF or regional FASTA for use elsewhere. |
| Project files rather than finished audio alone | Saved DGW projects | Reopen tracks, edits and device settings, rather than keeping only the exported sequence file. |
| Demo songs and project templates | Example projects and rack templates | Inspect prepared experiments, or start with a chosen set of devices. Opening an example creates a fresh working copy. |

For example, open an allele on a working track, choose another base in the Allele
Roll, apply the edit, and inspect its evidence. Then bypass the edit to compare
with the previous version. See [Tracks, Devices & Edits](../usage/edit-and-compare.md).

## Do I need to know music software to use DGW?

No. Start with a biological question: **what would change if this sample had a
different allele at this position?** Tracks keep the alternatives, devices provide
the tools, and the Monitor summarizes the evaluated changes.

## Where does the analogy stop?

DGW reports predicted consequences and available evidence, not a complete simulation
of biology. Its current track scores summarize independently evaluated allele effects;
they do not model variant interactions or measure disease probability. A lower score
does not establish that a genome is healthier, and a missing database match is not
evidence that an allele is harmless.

Devices are not audio VST plug-ins, and their order in the rack does not imply an
audio-like signal chain. Nor does every musical operation have a genomic equivalent:
moving a note in time is not the same as moving a variant to another coordinate.
See [Scoring & Evidence Methods](../technical-details/scoring-methods.md)
for the calculations and [Origin & Development](../about/origin-and-development.md)
for the design background.
