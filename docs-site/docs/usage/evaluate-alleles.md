# Evaluate Alleles

import useBaseUrl from '@docusaurus/useBaseUrl';

Evaluation always targets one exact normalized allele selected from an edit block or observed call. It does not infer evidence from a nearby position or a different representation of the same unnormalized indel.

## Which result answers your question?

| Result | Question it answers | What it does not establish |
| --- | --- | --- |
| Variant Consequences | What transcript effect is predicted for this exact allele? | Its clinical significance or the joint effect of nearby edits. |
| ClinVar | Does this exact allele have a record in the configured snapshot? | That an absent record means benign. |
| COSMIC, optional | Is this exact allele in the supplied local snapshot? | Disease probability for this sample. |
| Track Monitor | How do the track's independent-allele signals compare with its source? | A combined biological effect or whole-genome risk. |

:::tip[Start with one allele]
Click a variant mark or edit block, then read the Evidence Inspector. Use the Track Monitor for the aggregate view; changing which record is displayed in the Inspector does not change the track score.
:::

## Run the applied evidence devices

In the Device Browser, Variant Consequences, ClinVar, and COSMIC are all **Evidence** devices: they report annotations, predictions, classifications, or observations for one allele. DGW Starter applies them to a new track's Rack by default, between Mutation Generator and Genome Optimizer. Their code is separate from the configured models and database snapshots in the resource pack.

With DGW Starter, the selected track's Rack initially shows the complete seven-device workflow, including the read-only Variant Map after Genome Optimizer. A missing optional resource leaves its Evidence card unavailable and inert; the other cards, visualization, and genome editing continue to work. Selecting an allele automatically runs the applied, non-bypassed Evidence cards after a short debounce. Stable cached results appear first and DGW requests only missing device results. **Refresh active Evidence devices** and each card's manual action remain available. Bypassing an Evidence card hides and excludes its result for that track without changing any allele or edit block. Applied-chain and card-bypass choices persist in the `.dgw` workstation session.

## Consequence layer

<figure>
  <img src={useBaseUrl('/img/dgw-evidence-inspector.png')} alt="Evidence Inspector with transcript predictions and explicit no-exact-match database results" width="360" loading="lazy" />
  <figcaption>Current interface with controlled test responses, not a biological validation result. Predictions and database matches are shown separately.</figcaption>
</figure>

DGW sends each request as a VCF batch to the registered `bcftools csq --local-csq` engine. It reports effect, impact, gene, transcript, strand, amino-acid change, DNA change, bcftools version, and Ensembl annotation release. A no-feature result is shown explicitly rather than treated as missing database evidence.

When several records are returned, use **Transcript consequences** in the Evidence panel to inspect each transcript and its raw record. Other Evidence cards offer **Matched records**. Switching records changes only the displayed detail, not the allele or its score; the first record is not necessarily the most severe.

## Evidence layers

- **ClinVar** returns exact VCF records with significance, review status, conditions, identifiers, and oncogenicity fields when supplied by the configured release.
- **COSMIC** returns exact records from the user’s licensed local snapshot.

Each card reports one of [five explicit statuses](../reference/evidence-statuses.md). No exact ClinVar or COSMIC match is an absence of matching database evidence—not a benign classification.

## Provenance and cache

Results are cached per device by normalized variant key, device version, and device-resource fingerprint. Found and exact no-match results are durable; tool or resource errors are not cached. Imported VCF annotations are neither displayed nor used. New results have their own timestamp and recorded resource versions.

:::caution Per-variant interpretation
Variant Consequences results are independent per allele. DGW v0.1 does not calculate joint transcript/protein effects for nearby edits on the same genome copy. A device may place several edit blocks on one track, but their evidence cards remain separate. Track Profiler can submit all active mutation blocks to the applied Evidence devices in one coordinated run and aggregate their coverage and source-relative signals; it does not change the scientific scope of the underlying allele requests.

For the exact fields, transcript rule, numerical mapping, and formulas, see [Scoring and Evidence Methods](../technical-details/scoring-methods.md).
:::

## Optimizer scores are not live evidence

The experimental Genome Optimizer has two bounded paths. Conservative mode considers only REF and the exact source ALT at explicitly selected loci. Its **Distance from reference (ALT copies)** objective counts one model unit per selected non-reference allele copy and does not use annotations or Evidence devices. Saturation mode runs live Variant Consequences for all three non-REF SNV candidates at each selected position. A fixed ClinVar guard excludes exact Pathogenic/Likely pathogenic candidates where that guard applies; a missing database match stays unknown. COSMIC provide context and never reduce the score through absence.

REF is the registered reference allele, not a benign or healthy classification. Likewise, Minimize and Maximize mean lower or higher values of the displayed proxy score only.

The displayed aggregate is a sum of independent allele-copy contributions. It is not a new ClinVar classification, clinical conclusion, or calculation of the combined biological effect of all edits. Every proposed edit remains selectable for individual review, while Track Profiler can coordinate the independent live-evidence evaluations for the complete active edit set.

Generated edit operations persist. Current control settings and displayed results resume from the workstation session. Background optimizer jobs retain their structured request and aggregate result, and terminal device runs have separate immutable records of declared inputs, resource identity, and results. Bulk candidate rows omitted during computation are not reconstructed by restoring a panel.
