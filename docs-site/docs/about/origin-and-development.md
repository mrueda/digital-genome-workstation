# Origin and Development

Digital Genome Workstation grew from [mrueda](https://github.com/mrueda)'s idea of applying the non-destructive working model of digital audio workstations to human genome variation.

The central analogy is operational. The selected individual is a read-only source genome track. A user duplicates that track, applies devices, sees persistent edit blocks, bypasses changes, compares tracks, and consolidates only by explicit choice. Homologous chromosome copies A and B remain inside each complete diploid track; the labels do not imply parental origin. The immutable state DAG stays behind the interface as provenance.

## DAW behaviour and DGW architecture

DGW borrows documented workstation behaviour, not an assumed internal DAW database design. Ableton Live represents audio or MIDI as clips arranged on tracks and supports selection-based, non-destructive editing. Logic Pro provides track and project alternatives that can share underlying assets while preserving different edits. Reason keeps recordings on separate comp rows and combines them only when the user explicitly bounces the result. These behaviours informed DGW's source track, duplicated experimental tracks, persistent mutation blocks, bypass, and consolidation. See the official documentation for [Ableton Arrangement editing](https://www.ableton.com/en/live-manual/12/arrangement-view/), [Logic Track Alternatives](https://support.apple.com/en-gb/101922), [Logic Project Alternatives](https://support.apple.com/guide/logicpro/use-project-alternatives-and-backups-lgcpa158ef77/mac), and [Reason non-destructive audio editing](https://docs.reasonstudios.com/reason12/audio-editing-in-the-sequencer).

The explicit persistent edit graph is DGW's engineering choice. Public DAW documentation describes user-visible clips, alternatives, undo, comping, and bounce operations; it does not establish that Ableton, Logic, or Reason stores projects as an equivalent DAG. DGW combines the workstation interaction model with ideas familiar from version control and event-sourced systems: immutable states, parent-linked edits, shared ancestry, cheap branches, and reproducible materialization.

The current DGW graph is specifically a **tree-shaped directed acyclic graph**. Every generated genome state has one parent, while several tracks may point to and share the same existing state. Editing one track creates a new child branch. Genome Morph writes a new edit layer rather than creating a two-parent merge, so DGW should not be described as implementing Git-like merge commits.

The device-rack idea also provides a home for bounded generative tools. The implemented experimental Genome Optimizer can weight live predicted consequence impact and exact source-allele membership, with fixed ClinVar candidate screening and controls that limit positions and changes. Its output remains discrete alleles represented by individual reversible blocks or one indexed reversible bulk layer. DGW is not an attempt to make sequence behave like audio or to reproduce a music application's appearance.

The rack extends beyond editing: Variant Consequences, dbNSFP, ClinVar, and COSMIC are Evidence devices, while objective-driven track models such as Genome Optimizer belong to Analyze. “VST-like” is only the conceptual inspiration for a compatible device rack. DGW compatibility will come from a versioned structured Device API under host control, not from an audio plug-in format. Device code and biological resource packs remain separate so community software can evolve without bundling or relicensing large external databases.

This is an **independent side project developed by mrueda in his free time**. Human genomes come first. The first working version uses b37/hs37d5 and hg38 references, Ensembl gene annotations, dbNSFP, ClinVar, and COSMIC resources already maintained for related bioinformatics work. Runtime consequence prediction uses `bcftools csq`.

The project is created and maintained by [mrueda](https://github.com/mrueda).
