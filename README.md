# Digital Genome Workstation

Digital Genome Workstation (DGW) is a desktop application for testing changes to one genome without modifying the original VCF. It takes its working model from a digital audio workstation: duplicate a genome track, apply reversible changes through a device, inspect every change, bypass it, and consolidate only when you deliberately want a new baseline. It does not reproduce IGV or treat a genome as audio. The first supported resource profile is human b37/hs37d5, but the workstation model is not inherently human-specific.

DGW saves project changes immediately inside the active `.dgw` package; there is no separate Save command. The File menu displays the complete package path and an autosave indicator. A package contains its manifest, SQLite project state, frozen selected-sample VCF, and exports. The original input VCF remains unchanged.

A **genome track** is one complete diploid scenario for the selected sample within the calls supplied by the VCF. Chromosome copy A and chromosome copy B are the two homologous chromosomes inside that track; they are not separate tracks, DNA strands, or claims of maternal/paternal origin. An experimental track can be duplicated, renamed, selected, minimized, and archived without changing the read-only source track. A minimized track retains a thin clickable allele/edit overview. Edits remain visible as blocks over the focused region until they are bypassed, removed, or consolidated.

DGW v0.1 supports b37/hs37d5 SNVs and sequence-resolved indels with a 1–49 base length difference. It accepts normalized biallelic VCFs with or without annotations. Any imported INFO annotations are preserved only in the frozen source artifact and are ignored by DGW: they never supply a consequence, score, optimizer input, or edited-allele result. DGW skips unsupported symbolic/CNV, MNV, spanning-deletion, and larger allele records with an explicit warning; selects one sample as a project; reconstructs both genome copies in the region being edited; and evaluates exact alleles against the resources available on the local machine.

## Current capabilities

- Annotation-independent biallelic-VCF inspection and selected-sample projection, preserving phased and unphased genotypes.
- A track-and-device workspace built over an immutable SQLite edit DAG. The DAG remains internal provenance rather than the main user interface.
- A desktop application menu with persistent user settings for interface scale, panel, Device Rack and Track Monitor visibility, and reduced motion.
- Track duplication, rename, selection, visibility, archival, and isolated per-track edits.
- Reversible reference-restore and ALT-replacement operations at input-VCF positions, represented as persistent edit blocks with block- and device-level bypass.
- An experimental bounded Genome Optimizer with Conservative and selected-position Saturation modes.
- A Mutation Generator editing device whose first mode is a deterministic Randomizer: select visible VCF positions or the complete track across chromosomes, set an amount and seed, preview new SNV ALTs, and apply them as reversible mutation blocks.
- Explicit track consolidation: visible blocks become the new baseline while complete edit ancestry and bypassed baseline exclusions remain stored.
- A Device Browser grouped into Edit, Evidence, and Analyze, plus a per-track Device Rack below the tracks containing compact full panels for the explicitly applied devices. Panels run horizontally in applied order, keep operational controls visible, and fold reference text under **Details**; drag the rack's upper divider to resize it, and choose **Create → Add Device** to open the Browser.
- Reference-focused genome-copy reconstruction from BGZF FASTA plus FAI/GZI, with visual reference-versus-variant differences.
- Focused-region FASTA export containing reference, chromosome copy A, and chromosome copy B records; phase-unknown heterozygous alleles are masked and recorded in a companion table.
- A source-relative Track Meter with explicit SnpEff impact delta, per-edit evaluation state, and device coverage.
- Automatic exact-allele evaluation on selection, using a persistent SnpEff worker and exact tabix lookups against the configured resources.
- Per-device evaluation caches tied to exact normalized alleles and resource versions, with distinct found, absent, unavailable, and error states.
- Paged source-variant access, bounded track marks, broad-view density bins, and explicit cross-chromosome selection without loading every variant into the interface.
- Clean BGZF/CSI VCF export plus checksummed provenance and compressed live-evidence sidecars.
- Tauri 2 + React/TypeScript desktop interface for the complete workflow.

## Prerequisites

- Rust 1.86 or newer and Node.js 20 or newer.
- A b37/hs37d5 reference with `.fai` and `.gzi` indexes.
- bcftools, bgzip, and tabix for import, validation, and export.
- Optional Evidence-device resources: Java plus local SnpEff hg19 data, and indexed dbNSFP, ClinVar, and COSMIC snapshots.
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
cargo test -p dgw-core
npm run tauri dev
```

If compilation stops at `gdk-sys` with `gdk-3.0.pc` missing, the Ubuntu/Debian packages above have not been installed yet.

The development resource profile at `config/local-hs37d5.development.json` points to the existing `/media/mrueda/2TBS` stack. Edit the resource JSON in the onboarding screen for another machine.

On the onboarding screen, click **Open example** to create and enter a project from `fixtures/dgw-cluster.synthetic.vcf` in one step. Its fictional `DGW_DEMO` sample has ten variants across chromosomes 7 and 17. The initial chromosome 7 region contains seven nearby variants, making the clickable allele lollipops and horizontal timeline immediately visible; the Source Variants navigator can then jump to the chromosome 17 group. DGW creates the project package in `Documents/DGW Projects`. The separate `braf-v600e.synthetic.vcf` remains the exact-resource smoke-test fixture.

Run the real local-stack smoke workflow with:

```bash
cargo run -p dgw-core --example local_smoke -- \
  fixtures/braf-v600e.synthetic.vcf DGW_DEMO /tmp/dgw-braf-demo \
  config/local-hs37d5.development.json
```

The fixture genotype is synthetic and contains no patient data. The command creates a disposable project, evaluates BRAF V600E against the registered resources, restores it to reference, verifies bypass, and renders/re-inspects the resulting VCF.

The second fixture, `fixtures/1000G-HG00096.public.vcf.gz`, was extracted by selecting `HG00096` from a 2,504-sample public 1000 Genomes cohort. It contains 35 phased non-reference records and an adjacent CSI index. See [`fixtures/README.md`](fixtures/README.md) for provenance and the extraction command. Private project samples must never be used as fixtures.

## Input contract

- Human b37/hs37d5 coordinates and exact reference contig names (`1`, not `chr1`).
- One ALT per record; no symbolic alleles or gVCF blocks.
- Sorted, left-aligned, minimal alleles whose REF agrees with the registered reference.
- Diploid `GT`; imported INFO annotations are optional and ignored.
- BGZF `.vcf.gz` is the production format; plain VCF remains accepted for small development fixtures.

The project reconstructs reference plus supplied variant calls. Missing VCF records are not evidence that a position was callable or confirmed homozygous reference.

Microarray vendor text files, including direct-to-consumer formats such as 23andMe, are not direct DGW inputs. Convert them first to the same normalized, biallelic, single-sample VCF contract; beacon2-cbi-tools is the recommended preparation route for supported formats. The conversion must resolve build and strand semantics, and missing probes must never become assumed reference calls. Precomputed annotations in the converted VCF are harmless but unused. DGW remains VCF-native rather than maintaining a separate internal microarray representation.

## Scientific boundary

SnpEff consequences are computed independently per normalized allele in v0.1. Known phase is represented within chromosome copies A and B of a genome track; A/B is arbitrary unless explicit parental-origin metadata is supplied. Unphased heterozygous alleles remain explicitly chromosome-copy unknown. Several edit blocks can be shown together, but DGW does not yet calculate their joint transcript or protein consequence. ClinVar/COSMIC absence is displayed as “no exact match,” never as benign evidence.

The implemented **Genome Optimizer** is an experimental bounded search over named proxy scores, not a general genome-design or clinical-risk engine. **Conservative** mode uses **Distance from reference (ALT copies)** and stays within REF and the exact ALT originally observed at a selected VCF locus. One active non-reference allele copy is one model unit; no annotation or Evidence device contributes to that number. Minimize may restore an eligible source allele to REF, while Maximize may reintroduce that exact source ALT. **Saturation scan** takes explicitly selected imported SNV positions, evaluates all three possible non-REF bases with live SnpEff, and chooses the lowest- or highest-impact eligible ALT per position. A fixed ClinVar guard excludes exact Pathogenic/Likely pathogenic candidates when that guard applies; lack of a ClinVar match is unknown, not benign. Exact COSMIC and dbNSFP matches are evidence context rather than score reductions. Both modes preserve chromosome-copy placement and emit ordinary reversible edit blocks. Conservative bounds copy-level edits; Saturation bounds changed positions, so ten selected variants permit at most ten changed positions even when a homozygous position requires two internal blocks.

REF is simply the registered reference allele and therefore a useful measure of distance from the reference. It is not a synonym for healthy, normal, safe, ancestral, common, or benign. Likewise, a lower or higher proxy score describes only the named model and must not be presented as lower or higher disease.

The **Mutation Generator** works on selected VCF alleles. Its first available mode is **Randomizer**. **Select visible** selects the displayed interval; **Select all in track** or Ctrl/Command+A selects every active VCF allele across chromosomes. Amount controls which positions are included; Seed makes the same input and settings produce the same preview. The substitution pattern can be Uniform, Transitions only, Transversions only, or a Ti/Tv mixture with an explicit transition probability. Classes are defined relative to REF. Version 1 replaces canonical SNV ALTs only, never chooses REF or the current ALT, preserves phased/unphased chromosome-copy placement, and skips indels or positions for which the requested class has no new ALT. Preview reports transitions, transversions, and exclusions. Applying a preview writes ordinary reversible blocks as one Undo/Redo batch. Random output is not a prediction of viability, health, or disease. Future generation strategies belong as modes in this device instead of separate rack devices.

Scores are simple sums of independently scored allele copies in the explicit selection used by the current optimizer run. Nearby interactions, combined transcript/protein effects, penetrance, and whole-genome effects are not modeled. Controls never mix bases continuously. Generated results are ordinary reversible edit blocks and each allele still requires its own evidence review.

Large selections are represented symbolically rather than copied into browser memory. The backend exposes source pages of 200 rows, a track request returns at most 500 visible allele marks, and broad views use 256 density bins that can be opened into detailed lollipops. Genome Optimizer accepts at most 100 selected positions per run and Mutation Generator accepts at most 1,000. DGW reports an over-limit selection instead of silently truncating it.

Objective inclusion and device bypass are separate. An active device may display results without being included in the selected objective. If the objective includes a device and the user bypasses it, its effective weight becomes `0` while its configured weight and source data remain unchanged. Enabling it restores the configured contribution. Devices not named by an objective are shown as **Not in objective**, not as bypassed; adding a future device must never silently change an existing score.

**File → New Project** uses the built-in **DGW Starter** project template: Mutation Generator, SnpEff, dbNSFP, ClinVar, COSMIC, and Genome Optimizer are applied in functional order. Mutation Generator and Genome Optimizer remain inert until Preview/Apply or Run, so opening the template does not alter a genome. **File → New from Template** also offers an **Empty** project. When used from an open project, it creates and enters a separate project from the same imported source genome; existing experimental edits are not copied. From project setup, selecting a template still requires a VCF or the bundled example. Templates choose the starting project configuration and do not appear in the Device Browser. Duplicating a Genome Track copies its applied device chain. Available, applied, included, and bypassed are therefore distinct states.

Focused FASTA output is a consensus reconstruction from the registered reference plus VCF alleles and DGW edits, not a read-derived assembly or a claim that unreported VCF positions were observed as reference. Unphased heterozygous calls are masked rather than assigned to a genome copy. The Track Meter's red/green, above/below-zero display is a source-relative molecular-impact visualization, not a health or clinical-risk measurement.

VCF export is deliberately clean. It writes effective alleles, genotypes, phase, and DGW provenance, but it does not copy imported consequence INFO or insert live SnpEff/dbNSFP/ClinVar/COSMIC records into the VCF. Cached live results are written separately to `<output>.evidence.json.gz` with exact allele keys, device/resource identities, statuses, timestamps, and coverage; the provenance sidecar links and hashes that file.

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
