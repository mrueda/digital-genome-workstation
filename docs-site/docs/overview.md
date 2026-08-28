# Digital Genome Workstation

Digital Genome Workstation (DGW) is a desktop application for testing changes to one human genome without modifying its source VCF. It borrows the working model of a digital audio workstation: duplicate a track, apply reversible changes through devices, keep the changes visible, bypass them for comparison, and consolidate only by explicit choice.

Application-level navigation separates project work from user preferences. Interface scale, side-panel visibility, and reduced motion follow the user across projects without entering scientific project provenance.

DGW is a variant what-if workspace. It answers a focused question: **if this sample had a different allele at this VCF position, what predicted consequence and known evidence would that allele have?** You can use the reference allele or substitute another ALT, compare experimental genome tracks, and export the track you want to keep.

DGW is not IGV. It does not present chromosome-scale read tracks or accept BAM/CRAM input. The interface stays centered on the small region and allele currently being worked on.

## The track model

A **genome track** represents one complete diploid scenario for the selected sample, within the variants and uncertainty supplied by the input VCF. Chromosome copies A and B are the two homologous chromosomes inside that scenario. A/B is not a maternal/paternal ordering. They are not tracks of their own, and an unphased allele remains chromosome-copy unknown.

The imported sample becomes a read-only source track. Duplicate it before experimenting. Each duplicate may be renamed, selected, compared, or archived independently. Archiving an experimental track removes it from the workspace, not from the audit record.

```text
Source genome       ─────────────────────────────────────  read-only

Candidate A         ─────[A→T]────────[deletion]────────
                              persistent edit blocks

Candidate B         ─────[A→G]──────────────────────────
```

## Work areas

- **Variants** chooses an allele in the focused region.
- **Genome tracks** selects, duplicates, renames, compares, or removes a complete genome scenario.
- **Allele editor** opens below the tracks when an allele mark or edit block is selected. It shows the focused sequence and mutation controls.
- **Device rack** contains the tools that add or generate reversible changes.
- **Edit blocks** show where those changes affect the focused region and remain selectable until consolidation.
- **Evidence** predicts molecular consequences and looks for exact records for the selected allele.

Tracks, persistent edit blocks, the device rack, and consolidation are now the primary workspace. The Genome Optimizer is implemented as an explicitly experimental bounded prototype.

## The v0.1 workflow

1. Register local b37/hs37d5 reference, tool, and annotation resources.
2. Open a sorted, normalized, annotated, biallelic VCF.
3. Select one sample as the project genome.
4. Focus a variant or reference interval.
5. Duplicate the source track and rename the experimental track.
6. Select an input-VCF allele mark and restore its reference allele or replace its ALT on chromosome copy A, chromosome copy B, or with chromosome copy unknown.
7. Inspect each edit block and its per-allele consequence and evidence.
8. Bypass changes or compare tracks over the same coordinates.
9. Optionally consolidate a track, then export it as a normalized single-sample VCF.

## Devices and the Genome Optimizer

A device changes one experimental track while leaving its source intact. Bypassing the device previews the same track without its active changes.

The rack has three device roles:

- **Editing devices** propose reversible changes. Genome Optimizer is the first built-in example.
- **Analysis devices** predict consequences. SnpEff is the current built-in analysis device.
- **Evidence devices** retrieve structured exact-match evidence. dbNSFP, ClinVar, and COSMIC fill this role.

Device code is separate from its resource pack. For example, the SnpEff device is behavior, while the configured JAR, model, and reference data are resources. The VST-like analogy describes how devices fit into a rack; actual compatibility will use the structured, versioned [DGW Device API](technical-details/device-api.md).

Genome Optimizer currently has the visible rack controls. SnpEff and the evidence devices are still presented in the Evidence work area; moving every built-in behind one generic rack UI depends on the formal Device API.

The **Genome Optimizer** is an implemented experimental device for a duplicate track and selected region. Its controls define:

- **Alternate-allele burden**, which counts active alternate-allele copies and ignores the evidence-weight faders;
- **Predicted-impact burden**, an additive score using imported impact, recognized ClinVar classification, and exact source-membership signals;
- **Minimize** or **Maximize** for the selected score;
- Impact, ClinVar, and Source faders for the predicted-impact objective; and
- a maximum number of edits for one run.

Minimize proposes reference restorations only for active alleles that exactly match the immutable source VCF. Maximize only reintroduces exact original-source alleles that are currently absent; it does not synthesize worse alleles or rewrite a partially present genotype. Unsafe overlaps and ambiguous replacements are excluded.

The faders and knob adjust the model, not the nucleotides. Output alleles remain discrete: for example, `A` or `T`, never a continuous mixture of the two. Every accepted proposal becomes an ordinary visible, bypassable edit block on the selected track.

:::caution Model-specific results
The score is an additive sum of independent allele-copy values. It does not model interactions, combined transcript/protein effects, penetrance, or whole-genome effects. It is not total health, a diagnosis, or a combined biological consequence. “Maximize” means reintroduce missing source alleles that increase this named score, not maximize disease. DGW will not claim to generate a perfect or disease-free genome.
:::

:::note Prototype persistence limit
Generated allele edits persist as normal track history. Device settings, device-to-edit grouping, score components, exclusions, and the complete optimizer run are not yet stored in the project schema. They are lost when the application session ends.
:::

All current devices are built into DGW. External community-device installation and execution are a contract foundation and roadmap item, not an enabled plug-in system today.

## Prediction and evidence stay separate

SnpEff predicts transcript consequences. dbNSFP supplies computational scores for exact alleles. ClinVar and COSMIC report previously observed or curated evidence. DGW never treats “not found” as “benign,” and it keeps imported annotations distinct from results generated with the currently configured resource versions.

## Current boundary

v0.1 supports b37 SNVs and sequence-resolved insertions/deletions of 1–49 bases. Consequences are calculated independently for each variant. Copy reconstruction includes variants with known phase. Unphased heterozygous variants are kept separate and evaluated individually; DGW does not infer phase. Compound transcript/protein interpretation and general risk optimization are deferred.

DGW is research software and is not intended for diagnosis or clinical decision-making.
