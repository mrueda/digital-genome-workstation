# Evaluate Alleles

Evaluation always targets one exact normalized allele selected from an edit block or observed call. It does not infer evidence from a nearby position or a different representation of the same unnormalized indel.

In the device-rack model, SnpEff is an analysis device. dbNSFP, ClinVar, and COSMIC are evidence devices. Their code is separate from the configured models and database snapshots in the resource pack.

The selected track's rack shows all four in order. **Run** executes only that card for the selected allele. **Run all active devices** executes the enabled cards; if none are bypassed, DGW can use the combined project cache. Bypassing an analysis or evidence card hides and excludes its result for that track without changing any allele or edit block. These card bypass choices are currently application-session state.

## Consequence layer

DGW keeps one serialized SnpEff process open for the registered bundle. It reports effect, impact, gene, transcript, HGVS.c, HGVS.p, rank, and warnings. The first request starts the JVM and loads the hg19 model; subsequent requests reuse it.

## Evidence layers

- **dbNSFP** returns its exact allele row and exposes named score columns such as CADD and REVEL when present.
- **ClinVar** returns exact VCF records with significance, review status, conditions, identifiers, and oncogenicity fields when supplied by the configured release.
- **COSMIC** returns exact records from the user’s licensed local snapshot.

Each card reports one of [five explicit statuses](../reference/evidence-statuses.md). No exact ClinVar or COSMIC match is an absence of matching database evidence—not a benign classification.

## Provenance and cache

Results are cached by normalized variant key and resource-bundle fingerprint. Tool or resource errors are not cached. Imported VCF annotations remain visible as the annotations that came with the file; new results have their own timestamp and recorded resource versions.

:::caution Per-variant interpretation
SnpEff results are independent per allele. DGW v0.1 does not calculate joint transcript/protein effects for nearby edits on the same genome copy. A device may place several edit blocks on one track, but their evidence cards remain separate.
:::

## Optimizer scores are not live evidence

The experimental Genome Optimizer ranks allowed changes with one of two implemented additive scores: alternate-allele burden or predicted-impact burden. The predicted-impact score reads imported impact and recognized ClinVar-classification fields already attached to source variants, plus exact membership in the immutable source VCF. It does not run SnpEff or query the configured dbNSFP, ClinVar, or COSMIC resources while planning.

The displayed aggregate is a sum of independent allele-copy contributions. It is not a new ClinVar classification, clinical conclusion, or calculation of the combined biological effect of all edits. Every proposed edit remains selectable and should be evaluated separately through the live evidence stack.

Generated edit operations persist. The full optimizer request, score components, exclusions, device grouping, and control settings do not yet persist in the project schema. Until formal run provenance is implemented, a displayed optimizer score cannot be reconstructed from the project package alone.
