<p align="center"><img src="brand/dgw-mark.svg" width="128" alt="Digital Genome Workstation logo"></p>

# Digital Genome Workstation

Digital Genome Workstation (DGW) is a desktop application for testing changes to one genome without modifying the original VCF. It takes its working model from a digital audio workstation: duplicate a genome track, apply reversible changes through a device, inspect every change, bypass it, and consolidate only when you deliberately want a new baseline. It does not reproduce IGV or treat a genome as audio. The included development profiles support human b37/hs37d5 and GRCh38/hg38, but the workstation model is not inherently human-specific.

DGW saves project changes and workstation state automatically inside the active `.dgw` package. **File → Save Project** (Command/Ctrl+S) forces any pending interface state to disk, **Open Project** reopens an existing package, and **Save a Copy** creates an independent snapshot with a new project identity. The File menu displays the complete package path and save status. A package contains its manifest, SQLite project state, frozen selected-sample VCF, and exports. The original input VCF remains unchanged.

A **genome track** is one complete diploid scenario for the selected sample within the calls supplied by the VCF. Chromosome copy A and chromosome copy B are the two homologous chromosomes inside that track; they are not separate tracks, DNA strands, or claims of maternal/paternal origin. An experimental track can be duplicated, renamed, selected, minimized, and archived without changing the read-only source track. A minimized track retains a thin clickable allele/edit overview. Edits remain visible as blocks over the focused region until they are bypassed, removed, or consolidated.

DGW v0.1 supports b37/hs37d5 and GRCh38/hg38 SNVs and sequence-resolved indels with a 1–49 base length difference. It accepts biallelic and multiallelic VCF records with or without annotations. During import, DGW retains only records whose FILTER field is exactly `PASS`, projects the selected sample, decomposes every supported ALT into an exact allele, and normalizes that private project copy against the configured reference. The selected diploid GT and `/` versus `|` semantics are preserved, and the original VCF is never changed. Imported INFO annotations are ignored by DGW: they never supply a consequence, score, optimizer input, or edited-allele result. DGW reports excluded non-PASS records and skips unsupported symbolic/CNV, MNV, spanning-deletion, and larger alleles with an explicit warning; reconstructs both genome copies in the region being edited; and evaluates exact alleles against the resources available on the local machine.

## Current capabilities

- Annotation-independent VCF inspection, automatic normalization of the selected-sample project copy, exact-ALT decomposition of multiallelic records, and preservation of phased and unphased genotypes.
- A track-and-device workspace built over an immutable SQLite edit DAG. The DAG remains internal provenance rather than the main user interface.
- Resumable `.dgw` projects with autosaved focus, selection, track/device layout, device controls and previews, plus File-menu Open, Open Recent, Save, Save a Copy, and Close actions.
- A desktop application menu with persistent user settings for interface scale, panel, Device Rack and Track Monitor visibility, and reduced motion.
- Track duplication, rename, selection, visibility, archival, and isolated per-track edits.
- Reversible reference-restore and ALT-replacement operations at input-VCF positions, represented as persistent edit blocks with block- and device-level bypass.
- An experimental bounded Genome Optimizer with Conservative and selected-position Saturation modes.
- A Mutation Generator editing device whose first mode is a deterministic Randomizer: select visible VCF positions or the complete track across chromosomes, set an amount and seed, preview new SNV ALTs, and apply them as reversible mutation blocks.
- A separate Genome Morph editing device that moves an editable track toward another compatible project track by copying a chosen percentage of their discrete genotype differences as one reversible layer.
- Explicit track consolidation: visible blocks become the new baseline while complete edit ancestry and bypassed baseline exclusions remain stored.
- A Device Browser grouped into Edit, Evidence, Analyze, and Visualize, plus a per-track Device Rack below the tracks containing compact full panels for the explicitly applied devices. Panels run horizontally in applied order, keep operational controls visible, and fold reference text under **Details**; drag the rack's upper divider to resize it, and choose **Create → Add Device** to open the Browser.
- A read-only Variant Map visualization device that plots focused-region alleles on the source line and active mutation blocks by source-relative transcript-consequence impact delta. Higher, lower, neutral, and unevaluated states remain explicitly distinct, and every plotted mark opens the corresponding allele or edit.
- Reference-focused genome-copy reconstruction from BGZF FASTA plus FAI/GZI, with visual reference-versus-variant differences.
- FASTA-aligned Allele Roll with A/C/G/T lanes for staging manual SNV changes while preserving phased chromosome copies and copy-unknown unphased calls.
- Focused-region FASTA export containing reference, chromosome copy A, and chromosome copy B records; phase-unknown heterozygous alleles are masked and recorded in a companion table.
- A source-relative Track Meter with explicit consequence-impact delta, per-edit evaluation state, device coverage, automatic persistent background profiling, and profile reuse across unchanged duplicate tracks.
- Automatic exact-allele evaluation on selection, using batched `bcftools csq` prediction and exact tabix lookups against the configured resources.
- Per-device evaluation caches tied to exact normalized alleles and resource versions, with distinct found, absent, unavailable, and error states.
- A foldable source navigator organized as contig → occupied genomic region → focused alleles, plus bounded track marks, broad-view density bins, and explicit cross-chromosome selection without loading every variant into the interface.
- Assembly-matched Ensembl gene search by symbol or stable ID, with complete-gene focus, an interval/strand overlay, imported-allele counts, and symbolic gene-wide selection for editing and analysis devices.
- Clean BGZF/CSI VCF export plus checksummed provenance and compressed live-evidence sidecars.
- Tauri 2 + React/TypeScript desktop interface for the complete workflow.

## Prerequisites

- Rust 1.86 or newer and Node.js 20 or newer.
- A b37/hs37d5 reference with `.fai` and `.gzi` indexes.
- bcftools, bgzip, and tabix for import, validation, and export.
- An assembly-matched Ensembl GFF3 consequence resource, plus optional indexed dbNSFP, ClinVar, and COSMIC snapshots.
- Linux Tauri packages. On Ubuntu/Debian, install them before running any Tauri command:

```bash
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev
```

  macOS uses the system WebKit runtime.

DGW does not download or redistribute biological databases. Every project pins the paths, releases, and resource-bundle identity supplied by its user. A missing optional resource makes that Evidence device unavailable; it does not prevent VCF editing or invalidate the other devices.

## Development

```bash
npm install
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run docs:screenshots
cargo test -p dgw-core
npm run tauri dev
```

The Playwright suite exercises the real React application shell in Chromium with a browser-only mock at the Tauri command boundary. It protects visible starting actions, project-template access, settings persistence, About/authorship content, entry into the complete synthetic workspace, allele selection, Allele Roll access, and device reset. `npm run docs:screenshots` regenerates the setup, workspace, and Allele Roll images used by the documentation from that same synthetic interface state. It does not replace Rust tests or the real-stack smoke workflow for project files, biological resources, or native desktop integration. Set `PLAYWRIGHT_CHROMIUM_PATH` to use an existing Chromium executable instead of Playwright's downloaded browser.

If compilation stops at `gdk-sys` with `gdk-3.0.pc` missing, the Ubuntu/Debian packages above have not been installed yet.

The development resource profile at `config/local-hs37d5.development.json` points to the existing `/media/mrueda/2TBS` stack, including the optional Ensembl GRCh37 gene resource. Edit the resource JSON in the onboarding screen for another machine. Assembly-specific Ensembl GRCh37 and GRCh38 gene-resource descriptors are also available under `config/`.

Choose **File → Open Example Project** to open the prepared GRCh37 or GRCh38 allele-editing example. The same choices are available from the onboarding screen after selecting a reference profile. DGW creates a fresh project with the protected source track, `BRAF · restore to REF`, and `BRAF · alternative ALT`. The experimental tracks contain visible, reversible edits at the BRAF locus. Their underlying fixtures contain a fictional `DGW_DEMO` sample with ten variants across chromosomes 7 and 17. The initial chromosome 7 region contains seven nearby variants, making the clickable allele lollipops and horizontal timeline immediately visible; the Source Variants navigator can then jump to the chromosome 17 group. DGW creates each project package in `Documents/DGW Projects`. The files are independent assembly-specific fixtures—DGW does not perform liftover. The separate `braf-v600e.synthetic.vcf` remains the GRCh37 exact-resource smoke-test fixture.

Run the real local-stack acceptance workflow with:

```bash
make acceptance-all
```

This runs fresh GRCh37 and GRCh38 projects through real import, sequence reconstruction, exact-allele evidence, track duplication and editing, project reopen, regional FASTA export, and indexed VCF export with evidence and provenance sidecars. It also runs Mutation Generator, compact mutation-layer application, Track Profiler, Saturation minimize/maximize and no-op detection, completed-job persistence, and optimized-track export. The command requires the external resource paths in both local development profiles and prints the temporary project locations. Use `make acceptance-local` for the foundational workflow or `make acceptance-devices` for the device workflow. Both fixture genotypes are synthetic and contain no patient data.

The second fixture, `fixtures/1000G-HG00096.public.vcf.gz`, was extracted by selecting `HG00096` from a 2,504-sample public 1000 Genomes cohort. It contains 35 phased non-reference records and an adjacent CSI index. See [`fixtures/README.md`](fixtures/README.md) for provenance and the extraction command. Private project samples must never be used as fixtures.

## Input contract

- Human b37/hs37d5 or GRCh38/hg38 coordinates, selected explicitly during project setup. DGW safely maps `1`/`chr1` naming to the registered reference convention; it does not perform liftover.
- `FILTER=PASS`; failed filters and unfiltered `FILTER=.` records do not enter the project.
- One or more sequence-resolved ALT alleles per record; DGW decomposes multiallelic rows internally. Symbolic alleles and gVCF blocks remain unsupported.
- REF alleles that agree with the registered reference. Input alleles need not already be left-aligned or minimal; DGW normalizes and sorts its private selected-sample copy during import.
- Diploid `GT`; imported INFO annotations are optional and ignored.
- BGZF `.vcf.gz` is the production format; plain VCF remains accepted for small development fixtures.

The project reconstructs reference plus supplied variant calls. Missing VCF records are not evidence that a position was callable or confirmed homozygous reference.

Microarray vendor text files, including direct-to-consumer formats such as 23andMe, are not direct DGW inputs. Convert them first to a normalized, diploid single-sample VCF; beacon2-cbi-tools is the recommended preparation route for supported formats. The conversion must resolve build and strand semantics, and missing probes must never become assumed reference calls. Precomputed annotations in the converted VCF are harmless but unused. DGW remains VCF-native rather than maintaining a separate internal microarray representation.

## Scientific boundary

Transcript consequences are computed independently per normalized allele with `bcftools csq --local-csq` in v0.1. Known phase is represented within chromosome copies A and B of a genome track; A/B is arbitrary unless explicit parental-origin metadata is supplied. Unphased heterozygous alleles remain explicitly chromosome-copy unknown. Several edit blocks can be shown together, but DGW does not yet calculate their joint transcript or protein consequence. ClinVar/COSMIC absence is displayed as “no exact match,” never as benign evidence.

The implemented **Genome Optimizer** is an experimental bounded search over named proxy scores, not a general genome-design or clinical-risk engine. **Conservative** mode uses **Distance from reference (ALT copies)** and stays within REF and the exact ALT originally observed at a selected VCF locus. One active non-reference allele copy is one model unit; no annotation or Evidence device contributes to that number. Minimize may restore an eligible source allele to REF, while Maximize may reintroduce that exact source ALT. **Saturation scan** takes explicitly selected imported SNV positions, evaluates all three possible non-REF bases with live Variant Consequences, and chooses the lowest- or highest-impact eligible ALT per position. A fixed ClinVar guard excludes exact Pathogenic/Likely pathogenic candidates when that guard applies; lack of a ClinVar match is unknown, not benign. Exact COSMIC and dbNSFP matches are evidence context rather than score reductions. Both modes preserve chromosome-copy placement. Interactive results use ordinary reversible edit blocks; bulk results use one compact reversible mutation layer on the selected track. Conservative bounds copy-level edits; Saturation bounds changed positions, so ten selected variants permit at most ten changed positions even when a homozygous position requires two internal changes.

REF is simply the registered reference allele and therefore a useful measure of distance from the reference. It is not a synonym for healthy, normal, safe, ancestral, common, or benign. Likewise, a lower or higher proxy score describes only the named model and must not be presented as lower or higher disease.

The **Mutation Generator** works on selected VCF alleles. Its first available mode is **Randomizer**. **Select visible** selects the displayed interval; **Select all in track** or Ctrl/Command+A selects every active VCF allele across chromosomes. Amount controls which positions are included; Seed makes the same input and settings produce the same preview. The substitution pattern can be Uniform, Transitions only, Transversions only, or a Ti/Tv mixture with an explicit transition probability. Classes are defined relative to REF. Version 1 replaces canonical SNV ALTs only, never chooses REF or the current ALT, preserves phased/unphased chromosome-copy placement, and skips indels or positions for which the requested class has no new ALT. Preview reports transitions, transversions, and exclusions. Applying a preview writes ordinary reversible blocks as one Undo/Redo batch. Random output is not a prediction of viability, health, or disease. Future generation strategies belong as modes in this device instead of separate rack devices.

The **Genome Morph** device compares the effective genotype state of the selected editable track with another track in the same project. `0%` makes no change; `100%` makes the selected track state-equivalent to the target at their differing editable VCF positions. Intermediate percentages copy a stable set of whole-position changes in genomic or seeded-random order. Preview is a persistent background job; Apply writes one compact reversible mutation layer to the selected track and starts Track Profiler. It does not modify the target. Unphased genotype alleles are compared without treating VCF allele order as phase. Morph states are synthetic editing scenarios, not ancestors, descendants, offspring, evolutionary time points, or claims of biological viability.

Genome Morph currently works only between tracks derived from the same imported sample and callset. Morphing two genomes is a separate future workflow: its safe first form requires two samples from the same joint-called VCF, the same assembly and normalization contract, and explicit separation of `0/0` from missing `./.` within the jointly callable scope. Independently loaded VCFs cannot be compared safely by assuming every absent record is reference.

Scores are simple sums of independently scored allele copies in the explicit selection used by the current optimizer run. Nearby interactions, combined transcript/protein effects, penetrance, and whole-genome effects are not modeled. Controls never mix bases continuously. Generated results are reversible track operations—individual blocks for interactive runs or one indexed compound layer for bulk runs—and each allele can still be inspected against exact evidence.

Large selections are represented symbolically rather than copied into browser memory. The source navigator queries contig summaries and at most 24 occupied-region bins per expanded level; broad bins drill down lazily until they fit the 50 kb focused workspace. A track request returns at most 500 visible allele marks, and broad track views use 256 density bins. Genome Optimizer and Mutation Generator start with a user-configurable 1,000-position run limit and an experimental hard ceiling of 100,000. Optimizer selections above 100 positions run as persistent background jobs: Variant Consequences and ClinVar candidates are evaluated in batches, winners are reduced per position, detailed comparison rows are not transferred to the browser, and the chosen changes are applied as one compound layer. DGW reports an over-limit selection instead of silently truncating it.

Objective inclusion and device bypass are separate. An active device may display results without being included in the selected objective. If the objective includes a device and the user bypasses it, its effective weight becomes `0` while its configured weight and source data remain unchanged. Enabling it restores the configured contribution. Devices not named by an objective are shown as **Not in objective**, not as bypassed; adding a future device must never silently change an existing score.

**File → New Project** uses the built-in **DGW Starter** project template: Mutation Generator, Genome Morph, Variant Consequences, dbNSFP, ClinVar, COSMIC, Genome Optimizer, and Variant Map are applied in functional order. Mutation Generator, Genome Morph, and Genome Optimizer remain inert until Preview/Apply or Run; Variant Map is read-only, so opening the template does not alter a genome. **File → New from Template** also offers an **Empty** project. When used from an open project, it creates and enters a separate project from the same imported source genome; existing experimental edits are not copied. From project setup, selecting a template still requires a VCF or the bundled example. Templates choose the starting project configuration and do not appear in the Device Browser. Duplicating a Genome Track copies its applied device chain. Available, applied, included, and bypassed are therefore distinct states.

Focused FASTA output is a consensus reconstruction from the registered reference plus VCF alleles and DGW edits, not a read-derived assembly or a claim that unreported VCF positions were observed as reference. Unphased heterozygous calls are masked rather than assigned to a genome copy. The Track Meter's red/green, above/below-zero display is a source-relative molecular-impact visualization, not a health or clinical-risk measurement.

VCF export is deliberately clean. It writes effective alleles, genotypes, phase, and DGW provenance, but it does not copy imported consequence INFO or insert live Variant Consequences/dbNSFP/ClinVar/COSMIC records into the VCF. Cached live results are written separately to `<output>.evidence.json.gz` with exact allele keys, device/resource identities, statuses, timestamps, and coverage; the provenance sidecar links and hashes that file.

The public project and resource contracts remain **schema version 1**. Internal additive migrations and indexes do not change that public version.

Applied device chains, device settings, device bypass, generated-block grouping, and the full optimizer plan are currently session state rather than persisted project records. Generated edits and their ordinary immutable ancestry do persist. Reopening a project therefore preserves the genome track and starts it from DGW Starter, but does not yet restore a custom Rack or complete optimizer control/run provenance.

The community extension boundary will be a versioned, structured **DGW Device API**. Device code and biological resource packs are separate: devices provide behavior, while resource packs provide versioned reference/model/database inputs. Devices return proposals or results to the DGW host and never mutate a project directly. The current devices are built in; external device installation and execution are not enabled yet.

DGW is research software, not a diagnostic system.

The full Docusaurus documentation is in [`docs-site`](docs-site). Start with the [architecture](docs-site/docs/technical-details/architecture.md), [Device API and resource packs](docs-site/docs/technical-details/device-api.md), [input VCF contract](docs-site/docs/technical-details/vcf-contract.md), and [evaluation engine](docs-site/docs/technical-details/evaluation-engine.md).

## Citation

Machine-readable citation metadata is available in [CITATION.cff](CITATION.cff). No formal publication is available yet. For now, cite:

> Digital Genome Workstation: Interactive, Non-Destructive Editing and Evaluation of Genome Variants.
> <https://github.com/mrueda/digital-genome-workstation>

## Author

Created and maintained by [mrueda](https://github.com/mrueda).

## Copyright and License

Copyright (C) 2026 Manuel Rueda.

DGW is licensed under Apache-2.0. External tools and biological resources retain their own licenses and are not part of the DGW distribution.
