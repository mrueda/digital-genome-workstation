# Quick Start

## 1. Install development prerequisites

DGW currently runs from source. Install Rust 1.86+, Node.js 20+, Java, bcftools, bgzip, and tabix. On Ubuntu/Debian, Tauri also needs:

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

The onboarding screen begins with a development resource-bundle template. Its paths match the existing `/media/mrueda/2TBS` b37 stack; edit the JSON for another computer.

## Adjust the interface

DGW starts at a readable 110% scale. Use **Settings** in the application menu to choose an interface scale from 90% to 150%. DGW applies native whole-webview zoom, so panels, cards, tracks, controls, spacing, and text scale together. At 140–150%, hide the Variants or Evidence panel from **View** if you want to return more horizontal room to the genome workspace. The same settings panel stores side-panel visibility and reduced-motion preferences. These user preferences do not become part of a `.dgw` project.

The track arrangement always remains visible. Selecting a track shows its devices in the lower pane; selecting an allele mark or mutation block replaces that lower pane with the allele editor. Choose **Show devices** to return to the selected track's device chain.

## 3. Try the biological demonstration

Click **Load example**. DGW opens its bundled `dgw-cluster.synthetic.vcf`, selects `DGW_DEMO`, and suggests a new `.dgw` project location. Its seven fictional variants occupy a 55-base span, so the initial timeline shows several clickable allele lollipops at once. The genotypes contain no patient data. During development, you can also browse to the fixture yourself.

Click any lollipop to open that input-VCF allele in the lower editor. The BRAF V600E lollipop at `7:140453136 A→T` retains its recognizable annotation and is the best choice for **Run all active devices**. With the registered resource stack, SnpEff, dbNSFP, ClinVar, and COSMIC should report their per-allele results. The other nearby alleles are synthetic visual-workflow examples and may have no exact database match.

Duplicate the source genome track and name the duplicate `BRAF restore`. Click its BRAF allele mark to open the allele editor below the tracks. Choose **Use reference**, keep the chromosome copy unknown, and save the mutation. The restore remains visible as an edit block. Bypass it to compare the experimental track with its unchanged source, then enable it again.

You can perform the same bounded change through the experimental Genome Optimizer:

1. Start from a duplicate in which the BRAF source allele is active.
2. Select **Alternate-allele burden**, **Minimize**, and a maximum of one edit.
3. Choose **Generate edits**. The optimizer should add one reversible `T→A` restore block.
4. Bypass and re-enable the device to compare the same track without and with that block.
5. With the restore enabled, choose **Consolidate**. The block disappears into the new visual baseline, but its immutable ancestry remains.
6. Switch to **Maximize** and generate again. Because the exact BRAF source allele is now absent from the effective track, the optimizer can reintroduce that original allele as a new reversible block.

Maximize does not search for a more damaging allele. It only reintroduces an exact allele from the immutable source sample when that increases the selected additive score. See [Tracks, Devices, and Edit Blocks](edit-and-compare.md#optimizer-behavior) for the scoring rules and persistence limit.

## 4. Try the selected-sample cohort fixture

Open `fixtures/1000G-HG00096.public.vcf.gz` and select `HG00096`. This small fixture was extracted from a 2,504-sample public 1000 Genomes cohort and contains only the selected sample’s 35 phased non-reference records. It is public human variation data, not synthetic data; private project samples must not be used as fixtures.

For a command-line integration check of the same engine, see [Testing](../technical-details/testing.md).
