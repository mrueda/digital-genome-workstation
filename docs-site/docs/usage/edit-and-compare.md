# Tracks, Devices, and Edit Blocks

The main object in DGW is a genome track, not a history version. A track represents one complete diploid scenario for the selected sample. Chromosome copy A and chromosome copy B are the two homologous chromosomes inside the track; they are not independent tracks or forward/reverse DNA strands. A/B does not imply paternal/maternal origin.

The imported genome is the read-only source track. Duplicate it to create an experimental track, then rename, select, compare, or archive that track without affecting the source. A duplicate initially shares the same internal state and takes little additional storage. The UI action labelled **Delete** archives the track so its scientific ancestry remains in the project.

## Persistent edit blocks

Changes appear as blocks anchored to the focused reference coordinates. They remain visible and individually selectable until you remove them or consolidate the track.

Input-VCF alleles exist before any mutation and appear as clickable lollipops: a stem, diamond head, and `REF→ALT` label anchored to the genomic ruler. Selecting a lollipop opens that allele in the lower editor. Mutation blocks are a separate rectangular layer above the track, so observed/effective alleles are never confused with operations the user added. At broad zoom levels DGW hides lollipop text but retains the clickable heads to avoid label collisions.

### Horizontal navigation

The track deck can zoom and pan laterally like a DAW timeline. Hold **Ctrl** (or **Command** on macOS) and use the mouse wheel or trackpad to zoom around the pointer. Hold **Shift** and scroll, or use a native horizontal trackpad gesture, to pan along the contig. The navigator below the tracks provides direct left/right scrolling across the whole contig.

The header also provides pan and zoom buttons. The matching keyboard controls are **+** and **−** to zoom, **Shift + Left/Right** to pan, and **0** to fit the selected allele. **Fit allele** opens an 81-base window around that allele. DGW limits the viewport to 20 bp–50 kb and never moves beyond the reference contig.

The ruler, genomic grid, allele marks, and edit blocks move immediately during a gesture. At 240 bp or closer, each reference base receives its own lane division, making horizontal magnification directly visible. The reconstructed sequence and evidence view refresh after the movement settles, so track navigation does not launch an analysis request for every wheel event.

Use the **Height −/+** controls to make all tracks shorter or taller. Expanded tracks remain inside a vertically scrollable track deck, and the chosen height is remembered on the computer.

## Edit operations

- **Use reference** removes an observed or created allele from one genome copy and returns that span to reference.
- **Change ALT** removes the selected allele from one genome copy and sets a normalized SNV or short indel ALT at the same VCF position.

For an unphased heterozygous `0/1` call, the homolog carrying ALT is unknown. DGW therefore locks the editor to **Chromosome copy unknown**: **Change ALT** follows and replaces that existing unknown-copy ALT, preserving `0/1`, while **Use reference** removes it. A variant-only VCF export omits the restored position rather than writing an invented phased call. Chromosome copy A or B can be targeted only when the selected ALT is already phased onto that copy; DGW does not infer phase or parental origin.

REF is checked and the operation is normalized with the registered reference before it becomes an edit block. DGW rejects same-copy overlaps except an explicit replacement of its source allele.

The arrangement follows DAW selection behavior. Selecting a track opens its device chain in the lower pane. Selecting one of its allele marks or mutation blocks opens the allele editor in that same lower pane while leaving the tracks visible. Mutation coordinates and REF are locked to the selected input-VCF allele.

If the lollipop belongs to the protected source track, choose **Duplicate track and mutate** in the editor. DGW creates and selects an editable copy while keeping the same allele open. For **Change ALT**, the replacement must be a sequence-resolved allele different from the current ALT; the editor explains invalid or unchanged input before enabling the mutation button.

DGW does not allow an ordinary mutation at a coordinate absent from the input VCF. The reference FASTA supplies a reference base there, but a standard VCF cannot distinguish a confidently homozygous-reference position from an unreported or uncallable position. Arbitrary coordinate design would require a separately labelled hypothetical mode; it must not be presented as an observed property of the sample.

Selecting a block focuses its exact allele change and its evidence. Several blocks may coexist on a track, but each allele is evaluated separately. Their visual coexistence does not imply that DGW has calculated a joint transcript, protein, or disease effect.

## Device rack

Every selected track has an ordered device rack below the tracks. Devices run left-to-right, preserving the full horizontal width of the genomic timeline above. The rack contains SnpEff, dbNSFP, ClinVar, and COSMIC; these devices inspect one selected allele. Each can run independently, and its bypass switch excludes that result from the current track view without changing the genome.

Editable tracks also have the Genome Optimizer. It groups the edit IDs it generated for the duration of the application session. It can enable or bypass those blocks together without deleting them or later work. This makes the comparison explicit: the same track with the editing device active versus the same track with those generated blocks bypassed.

Editable tracks also contain an **Allele Randomizer**. Select one or more visible VCF lollipops—or use **Select all**—then set **Amount** and **Seed**. Preview shows the planned ALT substitutions without changing the project. Apply writes one ordinary reversible block per affected chromosome-copy placement. The same seed, amount, selection, and starting alleles produce the same plan. Version 1 accepts canonical A/C/G/T SNVs only, excludes REF and the current ALT from the replacement choices, preserves phased or unphased placement, and leaves indels unchanged. It does not estimate biological plausibility or a combined consequence.

Manual restore and ALT-replacement operations also become persistent blocks on the selected track. The experimental **Genome Optimizer** generates the same ordinary edit-operation type; its output can be selected, evaluated, and bypassed like a manual edit. See [Optimizer behavior](#optimizer-behavior).

## Track Meter

The Master Meter is fixed at the far right of the lower workspace as the selected track's source-relative output. It remains visible while the devices scroll and while the allele editor is open. Hide or restore it with **View → Master Meter**; that preference persists on the computer. The source allele is `0`; after an edit has been evaluated, the meter shows the change in its strongest SnpEff molecular-impact category. `HIGH = 1`, `MODERATE = 0.67`, `LOW = 0.33`, and `MODIFIER = 0.1`. Multiple active edit contributions are added only as a transparent visual summary.

A positive value enters the red area above zero, a negative value enters the green area, and zero means no change in this particular signal. The decibel-style display is a DAW analogy only. Red does not mean disease, pathogenicity, clinical risk, or biological harm, and green does not mean safe or healthy.

The meter reports how many active edits have actually been evaluated and shows coverage separately for SnpEff, dbNSFP, ClinVar, and COSMIC. It does not treat missing evaluation or absent database evidence as a beneficial result. ClinVar, dbNSFP, and COSMIC exact matches are shown as coverage/evidence counts; they are not silently mixed into the SnpEff impact number. Bypassing an edit removes its contribution, and bypassing SnpEff disables the aggregate impact readout.

Each allele is still evaluated independently. The meter does not model interactions among edits, combined transcript or protein consequences, penetrance, or disease burden. Meter evaluation snapshots currently last for the application session; persisted, reproducible meter provenance remains future work.

## Bypass

Bypassing one edit block previews the track without that operation. Bypassing the Genome Optimizer previews the track without the blocks generated by its current-session run. Neither action destroys anything. The active bypass mask is included when DGW calculates the focused sequence and exports the track.

Individual bypass choices persist with the track. Device-to-edit grouping does not yet persist, so after reopening the project the blocks remain individually bypassable but are no longer remembered as one optimizer run.

Analysis/evidence-card bypass is separate from edit-block bypass and currently does not persist. It only controls which device outputs participate in the current workspace view.

## Compare tracks

Select two tracks to compare the same focused coordinates. Differences are track-level scenarios; chromosome copies A and B remain inside each scenario. Version nodes and historical state slots are no longer the primary user model.

Internally, DGW retains an immutable state DAG. A track is a workspace identity pointing to a base state, head state, and bypass information. Duplicating a track can therefore share ancestry, while editing either duplicate creates a new branch. This internal model preserves undo, reproducibility, and audit without exposing database history as the main workflow.

## Consolidation

**Consolidate** turns the selected track's complete current effective genome into its new visual baseline. Technically, the track's base is moved to its head, so the existing edit blocks disappear from the active lane. DGW asks for confirmation because this deliberately flattens the visible workspace.

It is not destructive to biological state or ancestry. State and edit rows are retained. If an edit was bypassed at consolidation, DGW moves its ID into a private baseline-exclusion list before clearing the visible bypass list. The focused sequence therefore remains exactly the same before and after consolidation. Later edits appear as new blocks above that baseline.

Duplicating a consolidated track carries its private baseline exclusions forward. Track-based VCF export merges those private exclusions with the track's visible bypass choices, so the rendered genotype matches the effective track. Consolidation does not convert several allele-level annotations into a validated combined consequence.

## Optimizer behavior

The Genome Optimizer is an implemented experimental bounded prototype, not a general genome-design engine. It never creates an allele absent from the immutable source VCF.

Its two objectives are:

- **Alternate-allele burden**: one model unit per active alternate-allele copy in the focused region. The faders do not affect this objective.
- **Predicted-impact burden**: an additive per-copy score consisting of `Impact weight × impact signal + ClinVar weight × ClinVar signal + Source weight × exact-source signal`.

The imported impact signal is `HIGH = 1`, `MODERATE = 0.67`, `LOW = 0.33`, and `MODIFIER = 0.1`. Recognized ClinVar source classifications contribute `Pathogenic = 1`, `Likely pathogenic = 0.75`, uncertain/conflicting = `0.25`, and benign/likely benign = `0`; missing or unrecognized classifications contribute `0`. Exact membership in the original source contributes a source signal of `1`.

Direction has a deliberately concrete meaning:

- **Minimize** proposes `Use reference` for eligible active exact-source allele copies with a positive score.
- **Maximize** proposes reintroducing an exact original-source allele only when that allele is absent from the current track and doing so increases the score. It may replace an edited derivative that points back to that source allele. It does not invent a damaging allele or rewrite an ambiguous partially present genotype.

Candidates are ranked by score improvement and limited by **Maximum edits**. Overlaps, ambiguous replacements, zero-benefit changes, and other unsafe cases are reported as exclusions rather than guessed.

The displayed before/after score is the sum of independently scored allele copies. Interactions among nearby variants, phase-dependent combined consequences, penetrance, and whole-genome effects are not modeled. Candidate tracks keep every proposed allele as a selectable edit block for separate evidence review.

Terms such as **minimize** and **maximize** always apply to the displayed technical score. They do not mean minimize or maximize disease, health, or biological fitness. DGW will not claim a disease-free result.

The current project schema does not persist device settings, generated-edit grouping, proposal score components, exclusions, or the complete optimizer request/plan. The resulting edit operations and a short objective/direction note do persist in immutable ancestry. Formal optimizer-run provenance is required before this prototype can support reproducible model comparisons.
