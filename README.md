# Digital Genome Workstation

Digital Genome Workstation (DGW) is a desktop application for testing changes to one human genome without modifying the original VCF. It takes its working model from a digital audio workstation: duplicate a genome track, apply reversible changes through a device, inspect every change, bypass it, and consolidate only when you deliberately want a new baseline. It does not reproduce IGV or treat a genome as audio.

A **genome track** is one complete diploid scenario for the selected sample within the calls supplied by the VCF. Chromosome copy A and chromosome copy B are the two homologous chromosomes inside that track; they are not separate tracks, DNA strands, or claims of maternal/paternal origin. An experimental track can be duplicated, renamed, selected, and archived without changing the read-only source track. Its edits remain visible as blocks over the focused region until they are bypassed, removed, or consolidated.

DGW v0.1 supports b37/hs37d5 SNVs and sequence-resolved indels with a 1–49 base length difference. It accepts an annotated, biallelic VCF; skips unsupported symbolic/CNV, MNV, spanning-deletion, and larger allele records with an explicit warning; selects one sample as a project; reconstructs both genome copies in the region being edited; evaluates alleles with SnpEff, dbNSFP, ClinVar, and COSMIC; and writes a normalized single-sample VCF with a record of every change.

## Current capabilities

- Biallelic annotated-VCF inspection and selected-sample projection, preserving phased and unphased genotypes.
- A track-and-device workspace built over an immutable SQLite edit DAG. The DAG remains internal provenance rather than the main user interface.
- A desktop application menu with persistent user settings for interface scale, side-panel and Master Meter visibility, and reduced motion.
- Track duplication, rename, selection, visibility, archival, and isolated per-track edits.
- Reversible reference-restore and ALT-replacement operations at input-VCF positions, represented as persistent edit blocks with block- and device-level bypass.
- An experimental bounded Genome Optimizer with alternate-allele burden and predicted-impact burden objectives.
- A deterministic Allele Randomizer: select every visible VCF position, set an amount and seed, preview new SNV ALTs, and apply them as reversible mutation blocks.
- Explicit track consolidation: visible blocks become the new baseline while complete edit ancestry and bypassed baseline exclusions remain stored.
- A device model that treats Genome Optimizer as an editing device, SnpEff as an analysis device, and dbNSFP/ClinVar/COSMIC as evidence devices.
- Reference-focused genome-copy reconstruction from BGZF FASTA plus FAI/GZI, with visual reference-versus-variant differences.
- Focused-region FASTA export containing reference, chromosome copy A, and chromosome copy B records; phase-unknown heterozygous alleles are masked and recorded in a companion table.
- A source-relative Track Meter with explicit SnpEff impact delta, per-edit evaluation state, and device coverage.
- Persistent SnpEff worker and exact tabix lookups against the configured resources.
- Evaluation cache tied to the selected resource versions, with distinct found, absent, unavailable, and error states.
- BGZF/CSI render with edit metadata and a checksummed provenance sidecar.
- Tauri 2 + React/TypeScript desktop interface for the complete workflow.

## Prerequisites

- Rust 1.86 or newer, Node.js 20 or newer, Java, bcftools, bgzip, and tabix.
- A b37/hs37d5 reference with `.fai` and `.gzi` indexes.
- Local SnpEff hg19 data and indexed dbNSFP, ClinVar, and COSMIC snapshots.
- Linux Tauri packages. On Ubuntu/Debian, install them before running any Tauri command:

```bash
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev
```

  macOS uses the system WebKit runtime.

DGW does not download or redistribute biological databases. Every project pins the paths, releases, and resource-bundle identity supplied by its user.

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

On the onboarding screen, click **Load example** to open `fixtures/dgw-cluster.synthetic.vcf`. Its fictional `DGW_DEMO` sample has seven nearby variants, making the clickable allele lollipops and horizontal timeline immediately visible. DGW suggests a new project package in `Documents/DGW Projects`. The separate `braf-v600e.synthetic.vcf` remains the exact-resource smoke-test fixture.

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
- Diploid `GT` and a declared SnpEff `ANN` INFO field.
- BGZF `.vcf.gz` is the production format; plain VCF remains accepted for small development fixtures.

The project reconstructs reference plus supplied variant calls. Missing VCF records are not evidence that a position was callable or confirmed homozygous reference.

## Scientific boundary

SnpEff consequences are computed independently per normalized allele in v0.1. Known phase is represented within chromosome copies A and B of a genome track; A/B is arbitrary unless explicit parental-origin metadata is supplied. Unphased heterozygous alleles remain explicitly chromosome-copy unknown. Several edit blocks can be shown together, but DGW does not yet calculate their joint transcript, protein, or disease consequence. ClinVar/COSMIC absence is displayed as “no exact match,” never as benign evidence.

The implemented **Genome Optimizer** is an experimental bounded prototype, not a general genome-design or disease-risk engine. It has two objectives: alternate-allele burden and an additive predicted-impact burden built from imported impact, recognized ClinVar classification, and exact source-membership signals. **Minimize** restores eligible active source alleles to reference. **Maximize** can only reintroduce exact original-source alleles that are absent from the current track; it never invents a new allele or means “maximize disease.” The maximum-edits control bounds each run.

The **Allele Randomizer** works on selected, visible VCF alleles. **Select all** or Ctrl/Command+A selects every allele position in the focused region. Amount controls which positions are included; Seed makes the same input and settings produce the same preview. Version 1 replaces canonical SNV ALTs only, never chooses REF or the current ALT, preserves phased/unphased chromosome-copy placement, and skips indels. Applying a preview writes ordinary reversible blocks. Random output is not a prediction of viability, health, or disease.

Scores are simple sums of independently scored allele copies in the focused region. Nearby interactions, combined transcript/protein effects, penetrance, and whole-genome effects are not modeled. The faders tune score weights; they never mix bases continuously. Generated results are ordinary reversible edit blocks and each allele still requires its own evidence review.

Focused FASTA output is a consensus reconstruction from the registered reference plus VCF alleles and DGW edits, not a read-derived assembly or a claim that unreported VCF positions were observed as reference. Unphased heterozygous calls are masked rather than assigned to a genome copy. The Track Meter's red/green, above/below-zero display is a source-relative molecular-impact visualization, not a disease, health, or clinical-risk measurement.

Device settings, generated-block grouping, and the full optimizer plan are currently session state rather than persisted project records. Generated edits and their ordinary immutable ancestry do persist. Reopening a project therefore preserves the genome track but not the complete optimizer control/run provenance yet.

The community extension boundary will be a versioned, structured **DGW Device API**. Device code and biological resource packs are separate: devices provide behavior, while resource packs provide versioned reference/model/database inputs. Devices return proposals or results to the DGW host and never mutate a project directly. The current devices are built in; external device installation and execution are not enabled yet.

DGW is research software, not a diagnostic system.

The full Docusaurus documentation is in [`docs-site`](docs-site). Start with the [architecture](docs-site/docs/technical-details/architecture.md), [Device API and resource packs](docs-site/docs/technical-details/device-api.md), [input VCF contract](docs-site/docs/technical-details/vcf-contract.md), and [evaluation engine](docs-site/docs/technical-details/evaluation-engine.md).

## Citation

Machine-readable citation metadata is available in [CITATION.cff](CITATION.cff). No formal publication is available yet. For now, cite:

> Digital Genome Workstation: Interactive, Non-Destructive Editing and Evaluation of Human Genome Variants.  
> <https://github.com/mrueda/digital-genome-workstation>

## Author

Created and maintained by [mrueda](https://github.com/mrueda).

## Copyright and License

Copyright (C) 2026 Manuel Rueda.

DGW is licensed under Apache-2.0. External tools and biological resources retain their own licenses and are not part of the DGW distribution.
