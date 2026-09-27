# Understand results

import useBaseUrl from '@docusaurus/useBaseUrl';

DGW offers four ways to inspect results. Choose by the question you want to answer.

| Where | Scope | When to use it |
| --- | --- | --- |
| **Evidence panel** | One focused allele | Read transcript predictions and exact ClinVar/COSMIC records. |
| **Consequence Predictor → Selection report** | Current ALTs at selected loci, including unchanged loci | Browse and filter transcript effects. Choose **Create report**. |
| **Track Compare → Consequence changes** | DNA-different loci within the selection | Compare source/current transcript predictions. Choose **Compare consequences**. |
| **Track Monitor** | Active mutations on the selected track | Read the aggregate impact change and evaluation coverage. |

The Evidence panel and Monitor use the applied Consequence Predictor automatically. Creating a selection report is only needed when you want its table.

## Read the Monitor

<figure>
  <a href={useBaseUrl('/img/devices/monitor.png')}><img src={useBaseUrl('/img/devices/monitor.png')} alt="Track Monitor showing completed mutation coverage, mean impact delta and total delta" width="360" loading="lazy" /></a>
  <figcaption>Check completion and coverage before interpreting the score.</figcaption>
</figure>

| Readout | Meaning |
| --- | --- |
| **Mutations evaluated** | How many active mutation contributions have results. This need not equal the number of distinct changed loci. |
| **Total Δ** | Sum of source-relative predicted-impact changes for evaluated mutations. |
| **Mean Δ per mutation** | Total divided by the number of evaluated mutations. |
| **Lower / Unchanged / Higher** | Direction under the coarse consequence-impact categories. |
| **Device coverage** | Availability of predictions and database lookups for the evaluated changes. |

**DNA can change while the score stays at zero.** For example, a missense-to-missense substitution can retain the same impact category. Use Track Compare for the exact DNA and transcript differences.

ClinVar and COSMIC matches are reported separately; they are not added to the Monitor's impact score. Bypassing a database device removes its evidence contribution, not DNA. Consequence Predictor has no Bypass control.

## Inspect the evidence

<figure>
  <a href={useBaseUrl('/img/devices/evidence.png')}><img src={useBaseUrl('/img/devices/evidence.png')} alt="Evidence panel with labelled transcript consequences, impact, gene and resource details" width="420" loading="lazy" /></a>
  <figcaption>Predictions and database records are shown separately for the exact REF/ALT.</figcaption>
</figure>

| Result | How to read it |
| --- | --- |
| Transcript consequence | Computed by bcftools csq using the project's Ensembl model. Different transcripts can have different effects. |
| ClinVar match | Submitted interpretations for the exact allele in the configured release. Check review status and conditions. |
| COSMIC match | A record in your optional local COSMIC snapshot. |
| No exact match | The database was queried successfully but has no matching allele. |
| Unavailable / error | The resource could not be used. This is not a negative biological result. |

Use the record selector to inspect other transcripts or matched records. **Resource details** shows provenance; **Raw matched record** retains the original fields. Changing the displayed record does not change DNA or the score. [All status meanings](../reference/evidence-statuses.md).

## Filter predictions

In a Consequence Predictor report, select one or more **Consequence** and **Impact** chips. Filters apply across the saved report, before pagination. Open **Transcripts** for the matching locus. Track Compare has separate filters for different predictions, same predictions, missing evidence and REF restorations.

Reports can become outdated after edits or selection changes; rerun the requested report. Compatible exact-allele results are cached and reused. Imported VCF INFO annotations are ignored.

:::caution[What a score can tell you]
Scores summarize independently predicted effects. A lower score does not establish restored function, and neither REF nor missing database evidence establishes safety. Variant interactions and disease probability are not modeled.
:::

For calculations, candidate exclusions and reproducibility details, see [Scoring and evidence methods](../technical-details/scoring-methods.md). For optimizer modes, see [Edit and compare](edit-and-compare.md#optimizer-behavior).
