# Origin and development

DGW grew from Manuel Rueda's experience with music workstations and genome analysis. Music software makes it natural to keep an original, try changes on separate tracks and compare alternatives. DGW brings that workflow to genome variants.

## DAW and DGW side by side

| Familiar DAW concept | In DGW | What it lets you do |
| --- | --- | --- |
| Tracks and alternative takes | Genome tracks | Keep different versions of the same sample alongside a read-only source. Each track is a genome scenario, not one chromosome copy. |
| Piano roll | Allele Roll | Inspect and stage base changes in A/C/G/T lanes at imported SNV positions. The horizontal axis is genomic position, not time. |
| Selecting notes or events | Variant selection | Click individual alleles, drag a selection box, or select across the track before applying a batch operation. |
| Timeline zoom and track height | Genomic zoom, panning and resizable tracks | Move between a region overview and individual alleles, or make room by minimizing tracks. Broad views do not draw every allele separately. |
| Non-destructive edits | Mutation blocks and bulk layers | Keep changes visible and reversible without rewriting the source VCF. |
| Undo and redo | Workstation action history | Undo supported actions such as selection, track renaming and applied mutation batches. This session history is separate from the saved ancestry of genome edits. |
| Bypass | Mutation-block and database-device bypass | Temporarily exclude an edit, or exclude ClinVar/COSMIC evidence. Editing and Analyze devices do not have device-level Bypass. |
| Effects and instrument rack | Device Rack | Keep editing, evidence, analysis and visualization tools together on a track. |
| Selection-based MIDI generators | Mutation Generator | Generate changes for selected positions using controls such as amount, seed and substitution pattern, rather than editing each allele manually. |
| Output meter | Track Monitor | See evaluated changes relative to the source, including score direction and evaluation coverage. It measures a defined model output, not sound or health. |
| Transport controls | Variant review controls | Step through alleles or advance through them automatically for inspection. Playback does not simulate evolution or generate mutations. |
| Consolidate or bounce | Consolidation and export | Consolidation makes the effective track its new visual baseline while retaining ancestry. Export writes a VCF or regional FASTA for use elsewhere. |
| Project files rather than finished audio alone | Saved DGW projects | Reopen tracks, edits and device settings, rather than keeping only the exported sequence file. |
| Demo songs and project templates | Example projects and rack templates | Inspect prepared experiments, or start with a chosen set of devices. Opening an example creates a fresh working copy. |

## What the analogy means

A track represents one diploid scenario for the selected sample. Chromosome copies A and B are inside each track; they are not separate experiments or parental labels. Several edits can coexist, but predictions remain independent per allele.

Devices use DGW's own structured contract. They are not audio VST binaries, and their rack order does not imply a biological signal chain. External plug-in installation is not yet supported.

## The edit history is DGW's design

DGW stores parent-linked edits in a tree-shaped directed acyclic graph. Tracks can share a starting state and diverge; consolidation preserves ancestry. Genome Morph writes a new edit on its receiving track rather than merging two parents.

This is DGW's implementation choice, not a claim about how DAWs store their projects. See [DGW's state model](../technical-details/state-model.md).

## Musical inspiration

DGW draws on the wider music-workstation ecosystem, rather than one application. Examples include [Reason](https://www.reasonstudios.com/), [Ableton Live](https://www.ableton.com/en/live/), [Logic Pro](https://www.apple.com/logic-pro/), [FL Studio (Fruity Loops)](https://www.image-line.com/fl-studio) and [Pro Tools](https://www.avid.com/pro-tools).

## Author

Created and maintained by [Manuel Rueda](https://github.com/mrueda) as an independent project developed in his free time. The supplied resources currently support human GRCh37 and GRCh38; the track and device model is not inherently species-specific.

[Citation](citation.md) · [License](license.md) · [Roadmap](roadmap.md)
