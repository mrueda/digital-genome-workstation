# Quick Start

Start with a prepared example: compare an existing edit, make your own, then save the project. You do not need to configure an optimizer for this first pass.

## 1. Install the app and its resources

Follow [Install DGW](installation.md), then launch the installed application. On first launch, choose **GRCh37** or **GRCh38**, select a storage folder and click **Download and install**. When resources are ready, choose **Continue to examples**.

:::tip[Two separate downloads]
The installer contains DGW. Genome setup downloads the reference and supporting data for your assembly. No development tools or Java are required.
:::

## 2. Open an example

Use **Open an example** on the landing page, or **File → Open Example Project** from the menu.

![DGW landing page with the VCF workflow and example project buttons](/img/dgw-project-setup.png)

*Current interface with controlled demonstration data. Choose an example to start without supplying your own VCF.*

| Example | Best first use |
| --- | --- |
| GRCh37 allele editing | Inspect prepared BRAF edits and try a manual change. |
| GRCh38 allele editing | Try the same workflow with a separate GRCh38 fixture. |
| HG00103 exome — GRCh37 | Explore genes and bulk operations in a public 1000 Genomes WES call set. |

The small examples use ten fictional variants across chromosomes 7 and 17. The public exome is real public variation data, not synthetic data; it starts at `LDLR` without optimizer edits pre-applied. A gene's presence does not mean the sample carries a pathogenic variant in it.

:::note[Examples open as fresh working copies]
Your changes do not alter the bundled example. Use **File → Save Example as Project** to choose where to keep your work.
:::

## 3. Compare a prepared change

In the small GRCh37 example:

1. Select **BRAF · restore to REF**.
2. Click its mutation block to open the allele editor below the tracks.
3. Bypass the block, then enable it again. Compare the active allele and its evidence.

The source BRAF allele is `7:140453136 A→T`. The prepared restoration lets you compare against the source without creating a change first. **REF means the registered reference allele—not “healthy.”**

The Evidence Inspector describes the selected allele. The Track Monitor summarizes independently evaluated changes on the selected track. Check whether profiling has finished before interpreting an aggregate result.

## 4. Make your own edit

1. Duplicate **Source genome** and select the new track.
2. Click a variant mark. The lower pane opens on **Allele Roll**.
3. At that variant's column, drag the filled base block vertically to another A/C/G/T lane, or click the destination cell.
4. Review the staged change in the mutation panel, then apply it. Keep chromosome-copy placement unknown when the call is unphased.

![Allele Roll and mutation controls below the genome tracks](/img/dgw-allele-roll.png)

*The current allele editor with controlled demonstration data. A gesture stages the change; the mutation panel applies it.*

The coordinate cannot move horizontally. FASTA-only columns provide context; they are not additional editable VCF calls. **Sequence** shows reconstructed sequence strings. **Show devices** returns to the rack.

:::tip[Need more room?]
Use **Settings** to change interface scale and the colour theme. **View** controls panel visibility. Resize the divider between the tracks and lower pane; you do not need to keep every panel open.
:::

## 5. Save, reopen or export

| Action | Result |
| --- | --- |
| File → Save Example as Project | Creates your named `.dgw` package at a chosen location. |
| File → Save Project | Flushes pending session changes; named projects also autosave. |
| File → Open Project / Open Recent | Resumes the saved project. |
| File → Save a Copy | Creates a separate snapshot and keeps the original project open. |
| File → Export VCF / Export FASTA | Exports the selected track's VCF or the focused reference interval as FASTA. |

Open **File** to see the project path and save status. A `.dgw` package is your editable project; an exported VCF or FASTA is not a replacement for it. The input VCF is never modified.

## Next: genes and multiple positions

Open the HG00103 exome example to try gene navigation and larger selections. **Select visible** selects positions in the displayed interval; **Select all variants · all chromosomes** includes active VCF alleles across all chromosomes, not just the visible chromosome.

Then try [Mutation Generator or Genome Optimizer](edit-and-compare.md#optimizer-behavior), read [how evidence is evaluated](evaluate-alleles.md), or [load your own VCF](input-vcf.md). Device models remain independent-allele models even when thousands of positions are selected.
