# Tracks, Devices, and Edit Blocks

The main object in DGW is a genome track, not a history version. A track represents one complete diploid scenario for the selected sample. Chromosome copy A and chromosome copy B are the two homologous chromosomes inside the track; they are not independent tracks or forward/reverse DNA strands. A/B does not imply paternal/maternal origin.

The imported genome is the read-only source track. Duplicate it to create an experimental track, then rename, select, compare, minimize, or archive that track without affecting the source. Use the **−** control to fold a track into a thin overview and **+** to expand it; allele and edit markers remain clickable, and the choice is remembered locally. A duplicate initially shares the same internal state and takes little additional storage. The UI action labelled **Delete** archives the track so its scientific ancestry remains in the project.

The left **Variants** browser is a stable catalog of alleles imported from the source VCF. It does not add or remove rows when the selected working track restores an ALT to REF or introduces an edit. The backend returns 200-row pages and the browser renders only the rows currently on screen. Track-specific effective alleles and mutation blocks appear in the track lanes instead.

## Compare source and candidate

Open the **Track Compare** device to compare the selected track against Source. It replaces the track area; **Back to tracks** restores the workspace. The source column uses the individual's imported ALT, not the reference genome. Unphased calls remain unassigned.

**DNA changes** shows sequence differences. **Consequence changes** compares predictions at selected positions through Consequence Predictor. Select positions on the track, open this view and choose **Compare consequences**. There is no separate visible-region/whole-track scope switch: use the normal track selection controls, including Select all variants when needed. No selection means the comparison cannot run.

Choose **Evidence** for source/current results from active devices, or **Go to allele** to return to editing that position. Source alleles that cannot be resolved are marked unknown. This is not a replacement for background Track Profiler jobs.

### Whole-track DNA comparison

Select **DNA changes** to page across selected loci, including other contigs when they are selected. Each page contains at most 200 loci; all ALTs sharing a contig, position and REF stay together. Source and current columns show reconstructed allele/copy state. Edit IDs and history length do not determine whether DNA changed, and consolidation does not erase the comparison.

**Changed loci across track** finds changes across all imported loci and reports their total, then pages through those matches. The first request builds an in-memory locus index; subsequent pages reuse it until the track changes. The desktop keeps one such index, replacing it when another project, track or revision is compared. Turning the filter off returns to all imported loci and page-specific change counts.

**Open allele** opens the editor when a locus has one current ALT. For multiple ALTs or no remaining ALT, **Focus region** opens the genomic view without choosing an allele for you. Read errors offer Retry; a detected revision change between pages returns to the first page. Pages use database contig ordering.

This view compares DNA at imported coordinates; it does not enumerate unreported reference positions or independently introduced alleles outside those loci. “No ALT at this locus” describes the reconstructed state there, not a benign classification. Unphased genotype slots remain unassigned to parental chromosome copies.

### Selected consequence changes

Choose **Consequence changes**, then **Compare consequences**. Consequence Predictor must be enabled. This runs a background comparison of changed imported loci within the track's selection. All alleles at each selected locus stay together, including multiallelic changes and REF restorations; exclusions remove that locus from the comparison. Progress and cancellation are available while it runs; cancellation is checked between stages rather than interrupting a predictor process immediately.

DGW reuses cached exact-allele predictions and sends uncached source/current alleles to the existing consequence engine as a batch. Results are saved inside the project and displayed in pages of at most 200 loci. Filter by **Different predictions**, **Same predictions**, **Missing evidence**, or **REF restorations**. **Evidence** shows the saved source/current records; **Go to locus** returns to the editor.

The comparison uses transcript, consequence and impact tuples for each ALT copy. Two changes can have the same impact category but different consequences. Conversely, equal tuples do not establish equivalent biological effects. Missing or incomplete predictions are not classified as unchanged. A reduction in ALT-copy count is listed under REF restorations, including mixed loci that also contain a replacement ALT; it is not a benign classification. Interactions between alleles are not modeled. ClinVar and other Evidence devices remain available in the editor but do not determine these categories.

Changing the track, enabled Evidence devices or registered resource fingerprints makes the report outdated; rerun the comparison. Reopening the view restores a recent comparison only when its recorded selection matches. Changing selection never silently reuses a different scope's report. Clearing finished jobs removes that automatic entry, although the saved artifact and immutable run record remain in the project. A report-history browser is not yet available.

The backend currently reconstructs changed loci and holds their evidence in memory while generating the saved report. Paged display avoids rendering every result, but does not establish million-variant memory readiness.

## Persistent edit blocks

The allele editor separates **Reference**, **Saved on track**, and **Proposal · not saved**. Typing an ALT changes only the proposal; add the mutation block to save it and trigger evaluation. After restoring REF, the removed ALT can still be inspected, but its evidence is not evidence for the reference allele. Bypass the restoration block or undo it to edit that ALT again.

Changes appear as blocks anchored to the focused reference coordinates. They remain visible and individually selectable until you remove them or consolidate the track.

Input-VCF alleles exist before any mutation and appear as clickable lollipops: a stem, diamond head, and `REF→ALT` label anchored to the genomic ruler. Selecting a lollipop opens that allele in the lower editor. Mutation blocks are a separate rectangular layer above the track, so observed/effective alleles are never confused with operations the user added. A detailed track response contains at most 500 marks. Broader or denser views use 256 density bins; open a bin or narrow the region to recover individual lollipops.

### Context menus

Right-click—or Control-click on macOS—a variant lollipop, mutation block, or track header for actions specific to that object. The same menu opens from a focused control with the Context Menu key or **Shift+F10** and supports arrow-key navigation and Escape. Visible controls remain the primary route; no essential operation exists only in a context menu.

Right-clicking a lollipop already inside a multi-selection preserves the complete selection. This makes **Open selection in Mutation Generator** and **Open selection in Genome Optimizer** operate on the intended group. Right-clicking an unselected lollipop selects it first. **Edit in Allele Roll…** remains an explicit action and does not mutate the allele immediately. Mutation-block menus open or focus the block, reveal its effective allele, enable/bypass it, or refresh the Track Profile. Track-header menus cover selection, rename, duplication, minimization, visibility, profile refresh, and confirmed archive.

### Horizontal navigation

The track deck can zoom and pan laterally like a DAW timeline. Hold **Ctrl** (or **Command** on macOS) and use the mouse wheel or trackpad to zoom around the pointer. Hold **Shift** and scroll, or use a native horizontal trackpad gesture, to pan along the contig. The navigator below the tracks provides direct left/right scrolling across the whole contig.

The header also provides pan and zoom buttons. The matching keyboard controls are **+** and **−** to zoom, **Shift + Left/Right** to pan, and **0** to fit the selected allele. **Fit allele** opens an 81-base window around that allele. DGW limits the viewport to 20 bp–50 kb and never moves beyond the reference contig.

The ruler, genomic grid, allele marks, and edit blocks move immediately during a gesture. At 240 bp or closer, each reference base receives its own lane division, making horizontal magnification directly visible. The reconstructed sequence and evidence view refresh after the movement settles, so track navigation does not launch an analysis request for every wheel event.

### Go to a gene

Use **Go to gene** above Source Variants to search the project’s assembly-matched Ensembl index by gene symbol or Ensembl stable ID. Choosing a result focuses the complete 1-based inclusive GTF gene interval with a small amount of flanking context. DGW shows the stable ID, strand, coordinates, and number of imported VCF alleles inside the gene.

Focusing and selecting are deliberately separate. **Select alleles** creates a symbolic interval selection on the active track; Mutation Generator and Genome Optimizer receive the complete interval even when the gene is too wide or dense to render individual lollipops. DGW can only select imported VCF alleles in this version. A gene with no imported alleles remains navigable but provides no editable positions. Wide genes use density marks until the view is zoomed closely enough for individual alleles and reconstructed sequence.

Use the **Height −/+** controls to make all tracks shorter or taller. Expanded tracks remain inside a vertically scrollable track deck, and the chosen height is remembered on the computer.

## Edit operations

- **Use reference** removes an observed or created allele from one genome copy and returns that span to reference.
- **Change ALT** removes the selected allele from one genome copy and sets a normalized SNV or short indel ALT at the same VCF position.

For an unphased heterozygous `0/1` call, the homolog carrying ALT is unknown. DGW therefore locks the editor to **Chromosome copy unknown**: **Change ALT** follows and replaces that existing unknown-copy ALT, preserving `0/1`, while **Use reference** removes it. A variant-only VCF export omits the restored position rather than writing an invented phased call. Chromosome copy A or B can be targeted only when the selected ALT is already phased onto that copy; DGW does not infer phase or parental origin.

REF is checked and the operation is normalized with the registered reference before it becomes an edit block. REF means the registered reference allele; it is not a classification of health, safety, ancestry, frequency, or clinical significance. DGW rejects same-copy overlaps except an explicit replacement of its source allele.

The arrangement follows DAW selection behavior. Selecting a track opens its device chain in the lower pane. Selecting one of its allele marks or mutation blocks opens the allele editor in that same lower pane while leaving the tracks visible. Mutation coordinates and REF are locked to the selected input-VCF allele.

The allele editor opens in **Allele Roll** view for high-resolution SNV work. It aligns the forward-strand reference FASTA above four A/C/G/T lanes. The active allele is a filled, draggable base block like a MIDI note; its small A or B label identifies the chromosome copy, while U preserves an unphased, copy-unknown allele without assigning it to either copy. The highlighted column is the selected VCF locus. Drag the base block vertically to another lane, or click the destination base, to stage a new ALT. Dropping on the REF base stages restoration. The genomic coordinate stays fixed: horizontal dragging is deliberately unavailable. The Mutation editor follows the dragged chromosome-copy label and its explicit Apply button creates the reversible edit block. Clicking another VCF-labelled column opens that locus. **Sequence** switches to the three reconstructed reference/copy strings for the same interval.

![DGW Allele Roll opened below three genome tracks after selecting a reversible BRAF mutation block](/img/dgw-allele-roll.png)

*Selecting a lollipop or mutation block replaces the Device Rack with the Allele Editor while the genome tracks and Track Monitor remain visible.*

Muted Allele Roll columns provide FASTA context only. They cannot be clicked to create an ordinary sample mutation because the input VCF does not establish their callable genotype. Indels remain visible at their reference coordinate, but their full sequence is edited in the Mutation editor rather than forced into one-base lanes.

If the lollipop belongs to the protected source track, choose **Duplicate track and mutate** in the editor. DGW creates and selects an editable copy while keeping the same allele open. For **Change ALT**, the replacement must be a sequence-resolved allele different from the current ALT; the editor explains invalid or unchanged input before enabling the mutation button.

DGW does not allow an ordinary mutation at a coordinate absent from the input VCF. The reference FASTA supplies a reference base there, but a standard VCF cannot distinguish a confidently homozygous-reference position from an unreported or uncallable position. Arbitrary coordinate design would require a separately labelled hypothetical mode; it must not be presented as an observed property of the sample.

Selecting a block focuses its exact allele change and its evidence. Several blocks may coexist on a track, but each allele is evaluated separately. Their visual coexistence does not imply that DGW has calculated a joint transcript, protein, or disease effect.

## Device rack

Every selected track has a Device Rack below the tracks. It contains compact full panels for only the devices applied to that Genome Track, arranged horizontally in their applied order. Status, operational controls, results, and actions remain visible; resource metadata, explanations, scientific limitations, and long previews fold under **Details**. Scroll sideways to reach later devices; there is no separate Device Inspector. Drag the horizontal divider to give more room to either the tracks or rack, and double-click it to restore the default split. Hide or restore the complete rack with **View → Device Rack**.

Select Mutation Generator, Genome Morph, or Genome Optimizer and choose **Reset selected** to restore that device's factory controls and discard its current uncommitted preview or result. Reset is one interface Undo/Redo action. It does not delete, bypass, or rewrite mutation blocks that the device already applied to the genome track; those remain normal track history. Evidence and Visualization devices have no adjustable state in v0.1, so reset is unavailable for them.

Choose **Create → Add Device** in the application menu, or **+ Add device** in the rack, to open the separate full-size Device Browser. The browser, not the rack, groups everything available into **Edit**, **Evidence**, **Analyze**, and **Visualize**. Mutation Generator and Genome Morph belong to Edit; ClinVar and COSMIC to Evidence; Consequence Predictor and Genome Optimizer to Analyze; and Track Compare to Visualize. There is no separate Score group: applying an explicit objective to a track is an analysis, while a visualization only reads existing track and device results.

**File → New Project** starts from the **DGW Starter** project template, which pre-applies Mutation Generator, Genome Morph, Consequence Predictor, ClinVar, COSMIC, Genome Optimizer, and Track Compare. The editing devices and Genome Optimizer change DNA only when explicitly applied; Consequence Predictor evaluates focused alleles automatically; Track Compare is read-only. **File → New from Template** also offers an **Empty** project. Templates belong to project creation and never appear in the Device Browser. Duplicating a Genome Track copies its applied chain. Device installation, application, objective inclusion, and bypass are distinct states.

Mutation Generator, Genome Morph and Genome Optimizer create edits; they do not have a device-level Bypass control. Use Undo/Redo to reverse an action, or duplicate a track before editing to compare alternatives. Reset changes device settings, not the edits already applied.

Editable tracks contain a **Mutation Generator**, currently with one mode: **Randomizer**. Select VCF positions, set **Amount**, **Seed** and the substitution pattern, then click **Generate mutations**. There is no separate Preview or Apply step. Small runs add reversible blocks; bulk runs prepare a compact layer in a background job and attach it to the selected track when complete. Use Undo to reverse the applied action. Consolidation is separate. Track Compare reads the applied result, and Track Profiler evaluates it through the usual automatic processing flow.

Patterns are **Uniform**, **Transitions only**, **Transversions only**, and **Ti/Tv mixture** (with a transition-probability control). Classes are relative to REF. The same controls, selection and starting alleles produce the same plan. Only canonical A/C/G/T SNVs are supported; replacement choices exclude REF and the current ALT, preserve phased or unphased placement, and leave indels unchanged. Positions with no eligible replacement are skipped, not silently assigned another class.

**Maximum positions** defaults to 1,000 and can be raised to an experimental ceiling of 100,000. Generate stays disabled if the selection exceeds it; DGW never silently truncates the selection. Bulk mutations stay compact rather than rendering thousands of blocks. Failed or cancelled preparation does not attach a layer. Randomization itself does not predict biological plausibility or combined effects.

Editable tracks also contain a separate **Genome Morph** device. Choose another project track as the target, set Morph from `0%` to `100%`, and choose genomic or seeded-random ordering. Click **Apply morph** to compare effective genotypes and apply the chosen whole-position substitutions as one compact reversible layer. Preparation runs in the background; there is no separate preview to accept. Only the selected track changes, not the target. The operation adds one Undo action and starts Track Profiler when evidence devices are enabled. Changing controls alone does not edit either track. At `100%`, the selected track becomes state-equivalent to the target across their differing editable VCF positions. Unphased allele order is not treated as chromosome identity.

:::tip Morph from Source toward an edited track

Duplicate Source, select the copy, then choose the edited track under **Toward target track**. Apply morph changes the selected copy; Source and the target remain untouched.

:::

The percentage applies to **currently differing positions**, rounded up to whole positions. For example, with 20 differences, applying 50% copies 10 positions from the target. Applying 50% again copies 5 of the remaining 10; it does not recreate the original halfway state. At 0%, nothing changes—it does not undo an earlier run. For independent 25%, 50%, and 75% comparisons, make three duplicates of the same starting track and apply one amount to each.

These intermediate states are designed editing scenarios, not continuous nucleotide mixtures, evolutionary trajectories, ancestors, descendants, offspring, or viability predictions. Version 1 deliberately supports tracks from one imported sample. A future cross-genome mode must use two samples from the same joint-called VCF so explicit reference calls can be distinguished from missing calls; it also needs same-assembly normalization and callability-aware provenance. Two unrelated single-sample VCFs cannot safely supply those semantics.

Manual restore and ALT-replacement operations also become persistent blocks on the selected track. The experimental **Genome Optimizer** generates the same ordinary edit-operation type; its output can be selected, evaluated, and bypassed like a manual edit. See [Optimizer behavior](#optimizer-behavior).

## Track Monitor and Track Meter

The selected track's source-relative Track Meter lives in a dedicated **Track Monitor** at the far right of the complete workspace, outside the Device Rack. Hide or restore it with **View → Track Monitor**; that preference persists on the computer. DGW does not call this area a mixer because genome tracks are compared, not mixed. The source allele is `0`; after an edit has been evaluated, the meter shows the change in its strongest transcript-consequence impact category. `HIGH = 1`, `MODERATE = 0.67`, `LOW = 0.33`, and `MODIFIER = 0.1`. Multiple active edit contributions are added only as a transparent visual summary. A randomization can therefore change thousands of DNA alleles while leaving the meter at zero when every allele remains in the same coarse impact class. The direction distribution reports this explicitly; it is not the same as saying that no DNA changed.

A positive value enters the red area above zero, a negative value enters the green area, and zero means no change in this particular signal. The decibel-style display is a DAW analogy only. Red does not mean disease, pathogenicity, clinical risk, or biological harm, and green does not mean safe or healthy.

The meter reports how many active edits have actually been evaluated and shows coverage separately for Consequence Predictor, ClinVar, and COSMIC. It does not treat missing evaluation or absent database evidence as a beneficial result. ClinVar and COSMIC exact matches are shown as coverage/evidence counts; they are not silently mixed into the consequence-impact number. Bypassing an edit removes its contribution, and bypassing Consequence Predictor disables the aggregate impact readout.

Track Profiler starts automatically whenever the selected track has active mutation blocks and active Evidence devices but no compatible result. This includes reopening or selecting a stale track and applying, enabling, bypassing, undoing, or redoing mutations. Every run is a persistent background job: source/current alleles are deduplicated, Consequence Predictor receives one batch, and indexed databases are queried in bulk. The workspace remains usable while progress appears in Track Monitor and Jobs, where cancellation is available. **Analyze now** is an immediate override; after completion it becomes **Refresh profile**, while an incomplete run offers **Retry profile**. Consolidation is never required for evaluation.

Compatibility is determined by a scientific-input fingerprint rather than the track ID. It covers active allele-copy mutations and placement, active Evidence devices, and the resource-bundle fingerprint. Duplicating an unchanged profiled track therefore reuses the result immediately; changing the effective mutations, bypass state, Evidence-device set, or resources creates a different fingerprint and queues a new profile. Rename, zoom, allele selection, minimization, and unapplied device previews do not trigger analysis. This remains a coordinated run over independent allele requests, not a joint-effect calculation.

After a Genome Optimizer run, Track Monitor also identifies the applied device mode and direction, shows its objective before→after and delta, and reports positions scanned, candidate ALTs evaluated, and active/generated edit counts. This device-run strip is distinct from the vertical consequence meter: the former explains what the optimizer selected, while the latter measures only the mutation blocks actually active on the track relative to source.

Track Compare complements rather than replaces Track Monitor. The Monitor remains the compact track-wide summary. Choose **Open Track Compare** on the Track Compare rack card for a resizable focused-region view: source VCF alleles sit on the center line, while active mutation blocks move above or below it according to their source-relative consequence-impact delta. Red means higher model output, cyan lower, amber no change, and grey not evaluated. These colors do not mean diseased, healthy, pathogenic, or benign. Click a circle or diamond to open its allele or mutation block; Ctrl/Command-click a source mark participates in multi-selection. Dense views retain bounded representative marks rather than creating an unbounded browser graph.

Each allele is still evaluated independently. The meter does not model interactions among edits, combined transcript or protein consequences, penetrance, or disease burden. Track Profiler jobs persist their aggregate result and input fingerprint; terminal runs also enter the immutable device-run ledger.

### Track Compare views

Open **Track Compare** from the Visualize device in the rack. It fills the workspace; **Back to tracks** or Escape returns to editing. It starts with **DNA changes**, filtered to differing loci. **Genome view** maps effective DNA differences at different zoom levels. There is no separate Edit/Compare workspace switch.

| View | Scope | What it shows |
| --- | --- | --- |
| DNA changes | Track view selection | Paged DNA/genotype differences and a source/current allele matrix for up to 40 changed loci on the current page. Colour marks different DNA, not pathogenicity. Click a position or Inspect evidence to evaluate its exact source/current ALTs side by side. |
| Genome view | Track view selection, at any zoom | Binned DNA differences; zoom in for individual source/current alleles. Includes bulk layers. |
| Consequence changes | Selected positions | Compare individual Consequence Predictor predictions at changed selected loci. Track Monitor summarises a score; this view shows which predictions differ. Different consequences may have the same impact score. |

The reference is currently the imported **Source**; comparison against another candidate track is not implemented. All three tabs use the selection made in Track view and show the same allele count. With no selection, return to Track view to select variants. Select all variants includes every chromosome. Browsing, zooming and inspecting evidence do not replace the selection. DNA changes and Genome view load automatically; the play-icon **Compare consequences** button explicitly starts the prediction job. Missing predictions are not zero impact, and equal predicted scores do not mean equal sequences or equivalent biological function. Consequence comparisons run as background jobs.

In **Genome view**, each chromosome strip spans its imported-locus extent, not necessarily the entire chromosome. Strips have independent coordinate scales. Bar height shows the percentage of selected loci changed in each interval, on a fixed linear 0–100% scale. For example, 18 changed loci out of 120 gives a 15% bar. This is not statistical significance or predicted impact.

Bar segments describe the changes: cyan for ALT sequence changes, amber for ALT copies added or removed (including restoration to REF), and violet for copy assignment or phase changes with the same allele content. Each locus is counted once: a changed ALT-copy count takes priority, followed by changed ALT content, then placement/phase. Hover over an interval for the counts. Same genotypes have a neutral grey baseline; intervals with no selected loci have none. A thin marker in the most common change colour keeps sparse changes discoverable without exaggerating bar height.

Click a bin or drag across a strip to zoom. Keyboard users can focus a bin and press Enter. **Find gene** fits an annotated gene such as TTN; **Fit working region** uses the current workstation interval. **Full chromosome**, **Whole genome**, zoom buttons and **Back** let you recover context. Regions with at most 80 imported loci show aligned Source/Current allele cards; clicking one opens evidence.

The map uses effective genotypes, so reverted edits do not count as differences and bulk layers are not hidden. The backend returns at most 512 bins per chromosome and at most 80 detailed loci per request. Building the initial difference index still requires reconstructing the track; it is not constant-memory or instantaneous for arbitrary input sizes. Cached indexes are checked against the track head and bypass state.

Track Compare contributes no score and applies no edits. It displays DNA and results from the configured evidence machinery. Existing projects retain the device's internal identifier, `org.dgw.builtin.variant-map`.

In **DNA changes**, use **Find locus** to search a chromosome (`7` or `chr7`), position (`7:140453136`) or inclusive range (`7:140453000-140454000`). Coordinates are 1-based. Press Enter or Search to apply; Clear search restores the selected-locus list. Search runs before pagination across selected loci, and respects **Differences only**. The summary counts remain selection-wide; the page count reports search matches. Gene symbols are not supported in this field.

## Bypass

Device-level **Bypass** is available only on database Evidence devices (ClinVar and COSMIC). It excludes that evidence from evaluation without changing the genome. Consequence Predictor has no Bypass control; removing it from the rack makes the predicted-impact score unavailable, not zero. Bypassing ClinVar or COSMIC changes evidence coverage but not that score: neither contributes to its formula.

Individual edit blocks still have their own enable/disable control. This changes the effective genome, including sequence display and export, and is distinct from Evidence-device bypass. Later edits may depend on an earlier edit, so disabling arbitrary blocks is not equivalent to rerunning later devices. Use Undo/Redo to reverse an editing action.

Individual bypass choices persist with the track. The workstation session restores device grouping, while compound layers retain their device ID and child changes independently of that session.

Evidence-card bypass is separate from edit-block bypass and persists in the `.dgw` workstation session. Formula inclusion is separate again: an applied, active device can run and display results while the selected objective labels it **Not in objective**. Bypassing an included scoring device gives it an effective weight of `0` without deleting its source data or configured weight. Removing an included device from the rack also gives it an effective weight of `0`, but is shown as **Not in rack**, not bypassed. Enabling or adding it restores the configured contribution. None of these control changes rewrites existing genome edits; an affected Genome Optimizer result becomes pending until the user generates a new bounded proposal.

A device absent from a model is excluded, not automatically bypassed. This is the safe default for future devices: installing or enabling one must not silently alter existing results. Conservative uses no Evidence device. Saturation uses live Consequence Predictor impact, with ClinVar as a fixed candidate guard; COSMIC remain visible evidence rather than ranking terms.

## Undo and redo workstation actions

DGW keeps a session-only workstation action history, separate from scientific ancestry. Use **Edit > Undo** and **Edit > Redo** in the application menu. **Ctrl/Command+Z** and **Ctrl/Command+Shift+Z** provide the standard shortcuts. The menu names the next action when one is available.

Supported actions include variant selection—including lollipop clicks, marquee selection, Select visible, Select all variants, and Clear—track rename, device reset, manual mutations, and Mutation Generator, Genome Morph, or Genome Optimizer edit batches. An applied generated batch is one Undo action regardless of its block count. Undo bypasses its immutable edit blocks; Redo enables them again, preserving scientific ancestry. Actions share one chronological history: if a track rename follows a marquee selection, the first Undo restores the old track name and the next Undo restores the earlier selection. Undoing a selection or a device reset does not create a genome state or enter the scientific audit trail. Consolidation establishes a new visual baseline and clears obsolete edit-batch Undo entries for that track.

Direct bypass changes, track creation or archival, consolidation, navigation, and zoom remain outside the workstation Undo/Redo history.

## Compare tracks

Select two tracks to compare the same focused coordinates. Differences are track-level scenarios; chromosome copies A and B remain inside each scenario. Version nodes and historical state slots are no longer the primary user model.

Internally, DGW retains an immutable state DAG. A track is a workspace identity pointing to a base state, head state, and bypass information. Duplicating a track can therefore share ancestry, while editing either duplicate creates a new branch. This internal model preserves undo, reproducibility, and audit without exposing database history as the main workflow.

## Consolidation

**Consolidate** turns the selected track's complete current effective genome into its new visual baseline. Technically, the track's base is moved to its head, so the existing edit blocks disappear from the active lane. DGW asks for confirmation because this deliberately flattens the visible workspace.

It is not destructive to biological state or ancestry. State and edit rows are retained. If an edit was bypassed at consolidation, DGW moves its ID into a private baseline-exclusion list before clearing the visible bypass list. The focused sequence therefore remains exactly the same before and after consolidation. Later edits appear as new blocks above that baseline.

Duplicating a consolidated track carries its private baseline exclusions forward. Track-based VCF export merges those private exclusions with the track's visible bypass choices, so the rendered genotype matches the effective track. Consolidation does not convert several allele-level annotations into a validated combined consequence.

## Optimizer behavior

The Genome Optimizer is an implemented experimental bounded prototype. Both modes operate on an explicit selection, which may span chromosomes. **Conservative** mode is source-bounded. **Saturation scan** can create a different A/C/G/T ALT, but only at a selected SNV position already present in the imported VCF.

Conservative's objective is **Distance from reference (ALT copies)**: one model unit per active non-reference allele copy in the explicit selection. It uses no annotation, Evidence device, or health interpretation. Source membership comes from normalized allele identity in the immutable VCF rather than imported INFO.

Saturation uses the live Consequence Predictor impact signal: `HIGH = 1`, `MODERATE = 0.67`, `LOW = 0.33`, and `MODIFIER = 0.1`. Imported `ANN`, `CLNSIG`, and other INFO fields contribute nothing.

The complete scoring definition, including transcript aggregation, candidate selection, ClinVar screening, and formulas, is given in [Scoring and Evidence Methods](../technical-details/scoring-methods.md).

Direction has a deliberately concrete meaning in Conservative mode:

- **Minimize** proposes `Use reference` for eligible active exact-source allele copies with a positive score.
- **Maximize** proposes reintroducing an exact original-source allele only when that allele is absent from the current track and doing so increases the score. It may replace an edited derivative that points back to that source allele. It does not invent a damaging allele or rewrite an ambiguous partially present genotype.

Conservative candidates are ranked by score improvement and limited by **Maximum edits**. Saturation uses **Maximum changes**, capped at the number of selected variants; it is an upper bound, not a request to mutate every selected position. **Maximum positions per run** is a separate compute bound: it starts at 1,000 and can be raised explicitly to an experimental ceiling of 100,000. A homozygous winning position may require two internal allele changes, but it consumes one position from the change limit and both copies change atomically. The Saturation audit reports selected positions, candidate ALTs evaluated, positions where the current ALT is already best or tied, excluded positions, strict improvements, applied changes, and any improvements held back by the change limit. Overlaps, ambiguous replacements, zero-benefit changes, and other unsafe cases are reported as exclusions rather than guessed.

In Saturation mode, select one or more lollipops first. Explicit selection may span chromosomes even though the track canvas displays one interval at a time. DGW runs Consequence Predictor for all three non-REF bases at each selected canonical SNV and chooses the lowest- or highest-impact eligible ALT. Up to 100 positions retain the interactive detailed-candidate workflow. Larger accepted selections run as persistent, cancellable background jobs: the host resolves the symbolic selection, evaluates Consequence Predictor as one accepted-scope batch and the ClinVar guard in bounded batches, reduces each position to its winner, and applies the selected winners to the current track as one reversible compound layer. Individual comparison rows are deliberately omitted from bulk browser payloads. All three candidates must have a recognized `HIGH`, `MODERATE`, `LOW`, or `MODIFIER` result or the position is excluded. Exact ClinVar Pathogenic/Likely pathogenic candidates are ineligible under the fixed guard; no exact match remains unknown. COSMIC matches appear as evidence context, but a missing match does not reduce the score. Current phase/copy placement is preserved, and two-copy genotypes are never split merely to satisfy a bound.

The displayed before/after score is the sum of independently scored allele copies. Interactions among nearby variants, phase-dependent combined consequences, penetrance, and whole-genome effects are not modeled. Interactive runs keep proposed alleles as separate selectable edit blocks. A bulk layer stays compact in history, but its exact changes remain indexed and appear normally when their genomic region is focused.

Terms such as **minimize** and **maximize** always apply to the displayed technical score. They are not claims about the person's overall biology or clinical state.

The workstation session persists device controls and displayed plans. Immutable terminal device-run records retain the declared request, resource identity, result summary, and output edit or layer identifiers. Bulk summaries omit individual candidate rows; keep the pinned external resources available when repeating a comparison.
