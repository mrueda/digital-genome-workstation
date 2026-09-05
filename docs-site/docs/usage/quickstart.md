# Quick Start

## 1. Install development prerequisites

DGW currently runs from source. Install Rust 1.86+ and Node.js 20+. On Ubuntu/Debian, Tauri also needs:

```bash
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev
```

Install application dependencies and verify both layers:

```bash
npm install
npm run build
npm test
cargo test -p dgw-core
```

## 2. Start the desktop app

```bash
npm run tauri dev
```

Choose **GRCh37 (b37/hs37d5)** or **GRCh38 (hg38)** before selecting a VCF. Assembly cannot be inferred from a `chr` prefix and DGW does not perform liftover.

![DGW project setup with the reference profile, resource bundle, VCF selector and example-project action visible](/img/dgw-project-setup.png)

*Project setup keeps the VCF workflow and the prepared synthetic example together. The disabled workspace button becomes available after DGW has inspected an input and a project location is set.*

## Adjust the interface

DGW starts at a readable 110% scale. Use **Settings** in the application menu to choose an interface scale from 90% to 150% and select the System, Dark, or Light appearance. System follows the operating-system preference. DGW applies native whole-webview zoom, so panels, cards, tracks, controls, spacing, and text scale together. At 140–150%, hide the Variants or Evidence panel from **View** if you want to return more horizontal room to the genome workspace. The same settings panel stores side-panel visibility and reduced-motion preferences. These user preferences do not become part of a `.dgw` project.

The track arrangement always remains visible. Selecting a track shows its devices in the lower pane; selecting an allele mark or mutation block replaces that lower pane with the allele editor. Choose **Show devices** to return to the selected track's device chain.

## 3. Configure genome resources

Your sample VCF and DGW's supporting resources are separate. Import the VCF when creating a project. Install the matching resources once under **Settings → Resources → Install downloaded packages** by choosing:

- one b37 or hg38 data archive; and
- the DGW tool archive for your operating system and processor.

The data archive supplies the reference FASTA, ClinVar, gene index and transcript model. The platform archive supplies `bcftools`, `bgzip` and `tabix`; Java is not required. DGW checks the published archive identities, checksums and every extracted file before registering the bundle. It then appears as a resource choice on the project setup page.

During private development the archives are distributed separately and the automatic download list is disabled. The repository's `config/local-*.development.json` profiles remain available for this development machine; they contain local paths and are not portable packages. Once public release URLs are enabled, the same Resources page will download and install the pair instead of asking the user to locate the files.

## 4. Try the biological demonstration

Choose any prepared project under **Open an example** on the landing page. You can also use **File → Open Example Project** before or after opening another project. DGW opens a fresh, unsaved working copy; the bundled example itself is never changed. The GRCh37 and GRCh38 allele-editing examples contain `Source genome`, `BRAF · restore to REF`, and `BRAF · alternative ALT`. Use **File → Save Example as Project** if you want to keep your edits. The two experimental tracks contain visible, reversible edits at the BRAF locus, so you can inspect and bypass a change immediately instead of building the demonstration first.

The underlying fixture contains ten fictional variants across chromosomes 7 and 17 in the `DGW_DEMO` sample. The initial chromosome 7 region has seven variants in a 55-base span; use the Source Variants navigator to jump to the chromosome 17 group. Positions are 1-based. The fixtures contain no patient data and are independent assembly-specific files; DGW does not perform liftover.

From an open project, **File → New from Template** creates and enters a separate project using the same imported source genome and selected sample. It does not copy experimental edits. From the setup screen, a template only chooses the initial Device Rack; you must then choose a VCF or open the example.

DGW autosaves project changes and the current workstation session in the active `.dgw` package. Open **File** to see the complete package path and save status. Examples are the exception: their changes are autosaved only in a temporary working copy and they do not appear under **Open Recent** until you explicitly save them as projects. **Save Project** (Command/Ctrl+S) flushes pending interface state immediately; for an example, it first asks for a project name and location. **Open Project** and **Open Recent** resume an existing package; **Save a Copy** creates a separate snapshot and leaves the original project open. The original input VCF is never modified.

Click any lollipop to open that input-VCF allele in the lower editor. The BRAF V600E lollipop at `7:140453136 A→T` is the best exact-resource demonstration. The default **DGW Starter** template applies Mutation Generator, Variant Consequences, ClinVar, COSMIC, Genome Optimizer, and the read-only Variant Map. Selecting the allele automatically runs the available, active Evidence devices; imported INFO annotations are ignored. **Refresh active Evidence devices** remains available. Mutation Generator and Genome Optimizer do nothing until explicitly previewed/applied or run. The other nearby alleles are synthetic visual-workflow examples and may have no exact database match.

The lower editor opens on **Allele Roll**. Its REF row is the forward-strand FASTA and its A/C/G/T lanes show the possible SNV bases at the selected VCF column. On an editable track, drag the filled active base block vertically onto another lane, or click the destination cell, and then apply the staged mutation in the panel to the right. A/B/U appears as a small chromosome-copy label inside the block. Dropping on REF stages restoration; the coordinate cannot move horizontally. Muted FASTA-only columns are context rather than editable calls. Use **Sequence** to see the reconstructed reference, chromosome copy A, and chromosome copy B strings.

Select the prepared `BRAF · restore to REF` track and click its mutation block to open the allele editor. Bypass the block to compare the experimental track with its unchanged source, then enable it again. To repeat the operation yourself, duplicate `Source genome`, click its BRAF allele mark, choose **Use reference**, keep the chromosome copy unknown, and save the mutation.

You can perform the same bounded change through the experimental Genome Optimizer:

1. Start from a duplicate in which the BRAF source allele is active.
2. Keep **Conservative** mode, select **Distance from reference (ALT copies)**, **Minimize**, and a maximum of one edit.
3. Choose **Generate edits**. The optimizer should add one reversible `T→A` restore block.
4. Bypass and re-enable the device to compare the same track without and with that block.
5. With the restore enabled, choose **Consolidate**. The block disappears into the new visual baseline, but its immutable ancestry remains.
6. Switch to **Maximize** and generate again. Because the exact BRAF source allele is now absent from the effective track, the optimizer can reintroduce that original allele as a new reversible block.

Maximize does not search for a more damaging allele. It only reintroduces an exact allele from the immutable source sample when that increases the selected additive score. See [Tracks, Devices, and Edit Blocks](edit-and-compare.md#optimizer-behavior) for the scoring rules and persistence limit.

## 5. Try the public exome

**File → Open Example Project → HG00103 exome — GRCh37** opens a public 1000 Genomes WES call set spanning the autosomes and chromosome X. DGW imports 19,598 exact alleles, creates an untouched editable track, and focuses initially on `LDLR`. The call set also provides gene-level regions in `BRCA2`, `PCSK9`, `TP53`, and `HBB`. These are useful, recognizable places to explore; their presence does not mean that this individual carries a pathogenic allele in each gene.

Use this example to test navigation, gene selection, track duplication, Saturation, Mutation Generator, and other bulk operations on a realistic multi-chromosome project. No optimizer result is pre-applied. The bundled VCF contains only the selected sample and `GT`; imported INFO annotations are absent and unnecessary. Its source identity, extraction command, counts, and hashes are recorded in `fixtures/README.md`. It is public human variation data, not synthetic data; private project samples must not be used as fixtures.

For a command-line integration check of the same engine, see [Testing](../technical-details/testing.md).
