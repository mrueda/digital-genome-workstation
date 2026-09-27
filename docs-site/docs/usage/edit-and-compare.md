# Edit and compare

import useBaseUrl from '@docusaurus/useBaseUrl';

Work on **Working track**, or duplicate **Source genome** to create another alternative. The source is read-only. Rename tracks to describe the experiment you are trying.

## Make one edit

1. Select an editable track and click a variant diamond.
2. In **Allele Roll**, drag the active base vertically to another A/C/G/T row, or click its destination. This stages a proposal.
3. Review the ALT and chromosome-copy label, then choose **Add mutation block to track**.
4. Inspect the new block and the focused allele's Evidence. Track Monitor evaluates active changes automatically.

<figure>
  <a href={useBaseUrl('/img/devices/allele-roll.png')}><img src={useBaseUrl('/img/devices/allele-roll.png')} alt="Allele Roll with A/C/G/T lanes aligned to reference sequence and the mutation editor beside it" /></a>
  <figcaption>A gesture stages the allele; the mutation button saves the change on the track.</figcaption>
</figure>

| Control | What it changes |
| --- | --- |
| **Change ALT** | Replaces the current allele at that imported VCF position. Use the text field for an indel. |
| **Use reference** | Restores the selected allele copy to REF. |
| Edit-block **Bypass** | Temporarily excludes that block from the active track. |
| **Edit → Undo / Redo** | Reverses or reapplies a workstation action. |
| **Duplicate track** | Keeps another editable alternative. |

**A/B** identify phased chromosome copies, not parents. **U** means copy unknown; editing preserves that uncertainty. Muted FASTA columns provide sequence context and are not additional editable positions.

## Change many positions

Select variants in Track view, choose **Show devices**, and expand the tool you need.

| Tool | Action | Result |
| --- | --- | --- |
| [Mutation Generator](device-guide.md#mutation-generator) | Choose amount, seed and pattern; **Generate mutations**. | Applies reproducible SNV changes to this track. |
| [Genome Optimizer](#optimizer-behavior) | Choose mode, direction and maximum changes; run. | Applies eligible changes that improve the chosen objective. |
| [Genome Morph](device-guide.md#genome-morph) | Choose a target track and amount; **Apply morph**. | Copies that fraction of the remaining differences toward the target. |

Large operations run as background jobs and add a compact mutation layer. Follow progress in **Jobs**. The selected track receives the result; then the Monitor profiles it. You can inspect changes before consolidation.

### Optimizer behavior

| Mode | Candidates | Meaning of the score |
| --- | --- | --- |
| **Saturation scan** | All three non-REF bases at eligible selected SNV positions. | Weighted, independently predicted consequence impact. |
| **Conservative** | Reference and original source ALTs. | Distance from reference in ALT-copy units. |

Saturation preserves ties: if no eligible candidate improves the score, **zero changes is a valid result**. Exact ClinVar Pathogenic/Likely pathogenic candidates are excluded by its guard. Missing predictions can exclude a position; inspect the reported counts. [Full rules and formulas](../technical-details/scoring-methods.md).

## Compare the result

Keep your intended selection, then open **Track Compare**. Every view compares **Source → Current track**, including applied bulk edits.

| View | Question it answers |
| --- | --- |
| **DNA changes** | Which selected loci have different alleles, copy counts or phase placement? |
| **Genome view** | Where do the changes lie across the selected regions? |
| **Consequence changes** | Which changed loci have different transcript predictions? Press **Compare consequences** to calculate. |

<figure>
  <a href={useBaseUrl('/img/devices/genome.png')}><img src={useBaseUrl('/img/devices/genome.png')} alt="Track Compare Genome view locating changed selected variants across chromosomes" loading="lazy" /></a>
  <figcaption>Genome view summarizes broad intervals; zoom in to inspect individual differences.</figcaption>
</figure>

Use **Find locus** in DNA changes to search coordinates. In Consequence changes, filter the results and open a row's Evidence. A DNA change can leave the coarse impact category unchanged. [Understand the different readouts](evaluate-alleles.md).

:::note[Reset, Bypass and Undo have different purposes]
Reset restores a device's controls. It does not remove edits already applied. Device Bypass is available only for ClinVar and COSMIC; individual mutation blocks have their own Bypass. Use Undo to reverse an editing action.
:::

Next: [Save and export](render-state.md).
