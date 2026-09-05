# Digital Genome Workstation

Digital Genome Workstation (DGW) is a desktop application for testing changes to one genome without modifying its source VCF. It borrows the working model of a digital audio workstation: duplicate a track, apply reversible changes through devices, keep the changes visible, bypass them for comparison, and consolidate only by explicit choice. The development profiles support human b37/hs37d5 and GRCh38/hg38, but the track-and-device model is not inherently human-specific.

Application-level navigation separates project work from user preferences. Colour theme, interface scale, side-panel visibility, and reduced motion follow the user across projects without entering scientific project provenance.

DGW is a variant what-if workspace. It answers a focused question: **if this sample had a different allele at this VCF position, what predicted consequence and known evidence would that allele have?** You can use the reference allele or substitute another ALT, compare experimental genome tracks, and export the track you want to keep.

DGW is not IGV. It does not present chromosome-scale read tracks or accept BAM/CRAM input. The interface stays centered on the small region and allele currently being worked on.

![DGW showing source and experimental genome tracks, persistent BRAF edits, its Device Rack, Track Monitor and exact-allele Evidence](/img/dgw-workspace.png)

*The bundled synthetic GRCh37 demonstration. The source and two experimental genome tracks share one focused region; the selected track's devices sit below and its Track Monitor remains separate on the right.*

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
- **Allele editor** opens below the tracks when an allele mark or edit block is selected. Its Allele Roll aligns FASTA positions with A/C/G/T lanes for manual SNV staging; Sequence shows the reconstructed reference and chromosome-copy strings, and the Mutation editor applies the staged reversible change.
- **Device rack** contains the tools that add or generate reversible changes.
- **Edit blocks** show where those changes affect the focused region and remain selectable until consolidation.
- **Evidence** predicts molecular consequences and looks for exact records for the selected allele.

Tracks, persistent edit blocks, the device rack, and consolidation are now the primary workspace. The Genome Optimizer is implemented as an explicitly experimental bounded prototype.

## The v0.1 workflow

1. Register a local b37/hs37d5 reference and any optional Evidence resources.
2. Open a VCF. DGW retains strict `FILTER=PASS` records, accepts biallelic and multiallelic small variants, normalizes its selected-sample project copy, and ignores imported INFO annotations.
3. Select one sample as the project genome.
4. Focus a variant or reference interval.
5. Duplicate the source track and rename the experimental track.
6. Select an input-VCF allele mark and restore its reference allele or replace its ALT on chromosome copy A, chromosome copy B, or with chromosome copy unknown.
7. Select an allele and inspect the live exact-allele consequence and evidence returned by the available devices.
8. Bypass changes or compare tracks over the same coordinates.
9. Optionally consolidate a track, then export it as a normalized single-sample VCF.

## Devices and the Genome Optimizer

A device changes one experimental track while leaving its source intact. Bypassing the device previews the same track without its active changes.

The rack has four device roles:

- **Edit** devices propose reversible changes. Mutation Generator is the first built-in example.
- **Evidence** devices report allele annotations, predictions, classifications, or observations. Variant Consequences, ClinVar, and COSMIC fill this group.
- **Analyze** devices apply an explicit model to one or more track inputs. Genome Optimizer is the first built-in example and emits ordinary reversible proposals.
- **Visualize** devices present track state and available results without proposing edits or contributing to an objective. Variant Map is the first built-in example.

Device code is separate from its resource pack. For example, Variant Consequences is behavior, while the configured bcftools executable, Ensembl GFF3, and reference data are resources. The VST-like analogy describes how devices fit into a rack; actual compatibility will use the structured, versioned [DGW Device API](technical-details/device-api.md).

All built-ins appear in the function-grouped Device Browser, opened through **Create → Add Device** or the rack's add button. The selected track's Device Rack remains below the tracks and shows the full panels of only the instances applied to that track, arranged horizontally in order. The grouping describes purpose; it does not imply that outputs flow through an audio-like signal chain.

The built-in **DGW Starter** project template pre-applies Mutation Generator, Variant Consequences, ClinVar, COSMIC, Genome Optimizer, and Variant Map in functional order. Mutation Generator and Genome Optimizer remain inert until the user explicitly previews/applies or runs them; Variant Map is read-only. **File → New from Template** also offers an **Empty** project. These project-creation choices are separate from the Device Browser and provide an immediately understandable first-run workstation.

The **Genome Optimizer** is an implemented experimental device with two modes:

- **Conservative** works on the explicit selection and restricts proposals to REF restoration or reintroduction of an original source ALT;
- **Saturation scan** works on selected imported SNV positions, annotates all three non-REF bases with Variant Consequences, and chooses the lowest- or highest-impact ALT per position.

Its remaining controls define:

- **Distance from reference (ALT copies)** for Conservative mode: one model unit per selected non-reference allele copy, with no Evidence-device input;
- live transcript-consequence impact ranking for Saturation mode;
- **Minimize** or **Maximize** for the displayed model; and
- a maximum number of edits or positions for one run.

In Conservative mode, Minimize proposes reference restorations only for active alleles that exactly match the immutable source VCF. Maximize only reintroduces exact original-source alleles that are currently absent. In Saturation mode, transcript-consequence impact is the comparable ranking signal across every candidate. Exact ClinVar Pathogenic/Likely pathogenic candidates are excluded by a fixed guard where that guard applies; no match remains unknown. COSMIC matches are reported as evidence context but do not lower the score. Unsupported non-SNV positions and incomplete three-ALT comparisons are excluded rather than guessed.

The faders and knob adjust the model, not the nucleotides. Output alleles remain discrete: for example, `A` or `T`, never a continuous mixture of the two. Every accepted proposal becomes an ordinary visible, bypassable edit block on the selected track.

Conservative does not use Evidence-device outputs. Saturation uses live Variant Consequences impact and fixed ClinVar candidate screening; ClinVar is a guard, not a fader. Other devices can still run and display results but do not affect that ranking. A future device must never silently enter an established model.

:::caution Model-specific results
The score is an additive sum of independent allele-copy values. It does not model interactions, combined transcript/protein effects, penetrance, or whole-genome effects. It is not total health, a diagnosis, or a combined biological consequence. “Minimize” and “Maximize” refer only to the named proxy score.
:::

:::note Prototype persistence limit
Generated edits persist in track history. Device controls, rack configuration, and displayed plans resume from the project's workstation session. Separate immutable device-run records retain declared inputs, resource identity, and terminal result summaries. Bulk summaries do not contain every candidate comparison row.
:::

All current devices are built into DGW. External community-device installation and execution are a contract foundation and roadmap item, not an enabled plug-in system today.

## Prediction and evidence stay separate

Variant Consequences predicts transcript effects with `bcftools csq`. ClinVar and COSMIC report previously observed or curated evidence. DGW never treats “not found” as “benign.” Imported VCF INFO annotations are ignored; all displayed evidence comes from the currently configured resources.

## Current boundary

v0.1 supports b37 SNVs and sequence-resolved insertions/deletions of 1–49 bases. Consequences are calculated independently for each variant. Copy reconstruction includes variants with known phase. Unphased heterozygous variants are kept separate and evaluated individually; DGW does not infer phase. REF means the registered reference allele, not a healthy or benign state. Compound transcript/protein interpretation and general risk modeling are deferred.

Large projects stay bounded in the interface: source access is paged, broad track views use density bins, and detailed requests cap visible marks. Device runs have explicit position limits and fail clearly rather than silently dropping part of a selection.

DGW is research software and is not intended for diagnosis or clinical decision-making.
