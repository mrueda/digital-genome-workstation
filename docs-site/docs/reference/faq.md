# Frequently Asked Questions

## How does DGW differ from AlphaGenome Atlas?

[AlphaGenome Atlas](https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/) provides precomputed variant-effect predictions. DGW lets you edit a sample's variants, keep alternative tracks, compare results and export them. Its current consequence predictions come from bcftools csq.

The tools could complement each other: a future DGW device could use Atlas results. **AlphaGenome integration is not currently implemented.**

## Why is DGW inspired by digital audio workstations?

Music production has a mature way of working: try a change, compare alternatives,
temporarily disable an effect, and keep the original. DGW brings that approach to
genome-variant editing. The connection is about how you work, not just how the app looks.

The [DAW–DGW comparison table](../about/origin-and-development.md#daw-and-dgw-side-by-side) maps tracks, piano roll, devices, transport and other familiar controls to their genomic roles.

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
