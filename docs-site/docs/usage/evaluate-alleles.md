# Evaluate Alleles

Evaluation always targets one exact normalized allele selected from an edit block or observed call. It does not infer evidence from a nearby position or a different representation of the same unnormalized indel.

In the Device Browser, SnpEff, dbNSFP, ClinVar, and COSMIC are all **Evidence** devices: they report annotations, predictions, classifications, or observations for one allele. DGW Starter applies them to a new track's Rack by default, between Mutation Generator and Genome Optimizer. Their code is separate from the configured models and database snapshots in the resource pack.

With DGW Starter, the selected track's Rack initially shows the complete seven-device workflow, including the read-only Variant Map after Genome Optimizer. A missing optional resource leaves its Evidence card unavailable and inert; the other cards, visualization, and genome editing continue to work. Selecting an allele automatically runs the applied, non-bypassed Evidence cards after a short debounce. Stable cached results appear first and DGW requests only missing device results. **Refresh active Evidence devices** and each card's manual action remain available. Bypassing an Evidence card hides and excludes its result for that track without changing any allele or edit block. Applied-chain and card-bypass choices are currently application-session state.

## Consequence layer

DGW keeps one serialized SnpEff process open for the registered bundle. It reports effect, impact, gene, transcript, HGVS.c, HGVS.p, rank, and warnings. The first request starts the JVM and loads the hg19 model; subsequent requests reuse it.

## Evidence layers

- **dbNSFP** returns its exact allele row and exposes named score columns such as CADD and REVEL when present.
- **ClinVar** returns exact VCF records with significance, review status, conditions, identifiers, and oncogenicity fields when supplied by the configured release.
- **COSMIC** returns exact records from the user’s licensed local snapshot.

Each card reports one of [five explicit statuses](../reference/evidence-statuses.md). No exact ClinVar or COSMIC match is an absence of matching database evidence—not a benign classification.

## Provenance and cache

Results are cached per device by normalized variant key, device version, and device-resource fingerprint. Found and exact no-match results are durable; tool or resource errors are not cached. Imported VCF annotations are neither displayed nor used. New results have their own timestamp and recorded resource versions.

:::caution Per-variant interpretation
SnpEff results are independent per allele. DGW v0.1 does not calculate joint transcript/protein effects for nearby edits on the same genome copy. A device may place several edit blocks on one track, but their evidence cards remain separate. Track Profiler can submit all active mutation blocks to the applied Evidence devices in one coordinated run and aggregate their coverage and source-relative signals; it does not change the scientific scope of the underlying allele requests.
:::

## Optimizer scores are not live evidence

The experimental Genome Optimizer has two bounded paths. Conservative mode considers only REF and the exact source ALT at explicitly selected loci. Its **Distance from reference (ALT copies)** objective counts one model unit per selected non-reference allele copy and does not use annotations or Evidence devices. Saturation mode runs live SnpEff for all three non-REF SNV candidates at each selected position. A fixed ClinVar guard excludes exact Pathogenic/Likely pathogenic candidates where that guard applies; a missing database match stays unknown. COSMIC and dbNSFP provide context and never reduce the score through absence.

REF is the registered reference allele, not a benign or healthy classification. Likewise, Minimize and Maximize mean lower or higher values of the displayed proxy score only.

The displayed aggregate is a sum of independent allele-copy contributions. It is not a new ClinVar classification, clinical conclusion, or calculation of the combined biological effect of all edits. Every proposed edit remains selectable for individual review, while Track Profiler can coordinate the independent live-evidence evaluations for the complete active edit set.

Generated edit operations persist. The full optimizer request, score components, exclusions, device grouping, and control settings do not yet persist in the project schema. Until formal run provenance is implemented, a displayed optimizer score cannot be reconstructed from the project package alone.
