# Roadmap

## v0.1 foundation — Working engine

- Strict-PASS b37 VCF import with automatic normalization of a private selected-sample copy, internal exact-ALT decomposition of multiallelic rows, optional INFO annotations, and phased or unphased diploid GT support.
- Focused two-copy DNA reconstruction with explicit copy-unknown alleles.
- Immutable SNV/short-indel edits, branches, bypass, and internal A/B pointers.
- Per-allele Variant Consequences plus exact dbNSFP, ClinVar, and COSMIC evidence.
- Normalized VCF render with full provenance.
- Linux and macOS desktop development path.

## Implemented — Track workspace

- A genome track is the primary object: one complete diploid scenario containing homologous chromosome copies A and B, with parental origin unknown unless explicitly supplied.
- The imported sample is a read-only source track.
- Experimental tracks can be duplicated, renamed, selected, compared, hidden, and archived.
- Manual and generated changes are persistent, selectable edit blocks over shared focused coordinates.
- Each editable track has a device rack with edit-level and current-session device bypass.
- A function-grouped Device Browser is separate from each track's ordered applied-device Rack below the tracks; applied devices appear there as horizontally arranged full panels, and the source-relative Track Meter has a separate Track Monitor area.
- File-level DGW Starter and Empty project templates establish a complete inert-until-run workstation versus a blank starting chain; duplicating a track copies its applied chain. Templates remain separate from the Device Browser.
- Version history and A/B state slots are out of the primary workflow while the immutable DAG remains internal provenance.
- Consolidation moves the visual base to the current head, retains complete ancestry, and privately preserves bypassed baseline edits.
- Track-based VCF export merges private baseline exclusions and visible bypass choices.

## Implemented experimental prototype — Genome Optimizer

- Conservative **Distance from reference (ALT copies)** objective with no annotation or health interpretation.
- Minimize restores eligible active exact-source alleles to reference.
- Maximize only reintroduces exact original-source alleles absent from the current track; it is not disease maximization.
- Live `bcftools csq` candidate ranking and fixed ClinVar candidate screening for Saturation.
- Explicit objective inclusion versus user bypass: included bypassed devices contribute zero while excluded/new devices cannot silently enter a score.
- Maximum-edits bound, deterministic ranking, and explicit candidate exclusions.
- Proposals become normal visible, reversible edit blocks with individual evidence review.
- Selected-position Saturation scan evaluates all three non-REF canonical-SNV bases with Variant Consequences, reports database evidence separately, and preserves copy placement.
- The interface reports the additive-score limitation: no interactions, compound effects, penetrance, or whole-genome model.

## Engineering next

- Persist device settings and device-to-edit ownership.
- Add formal optimizer-run provenance: input identity, scoring contract/version, request, components, exclusions, output edit IDs, and uncertainty.
- Benchmark and harden bulk Saturation near its experimental ceiling, add resumable resource-fingerprinted candidate caches, and retain a bounded downloadable audit artifact without transferring every comparison row into the live interface.
- Include track identity, consolidation details, and device/run records in export provenance.
- Publish versioned DGW Device API schemas for editing, analysis, and evidence devices.
- Move built-in Genome Optimizer, Variant Consequences, dbNSFP, ClinVar, and COSMIC adapters behind the same conformance-tested host boundary.
- Present built-in editing, analysis, and evidence devices through one generic rack lifecycle and UI.
- Formalize resource-pack manifests separately from executable device manifests.
- Define external-device isolation, permissions, cancellation, failure handling, and reproducibility before enabling third-party execution.
- Add community package discovery, installation, upgrades, and removal only after that trust boundary is implemented.
- Project/resource migration tooling and stronger content fingerprints.
- Richer transcript/exon focus and sequence-difference presentation.
- Pluggable evaluators and configurable evidence summaries.
- Redistribution-safe test bundles and packaged desktop releases.

## Implemented experimental prototype — Genome Morph

- A separate Edit device compares effective genotype states between compatible tracks in one project.
- `0%` preserves the selected source track; `100%` copies every differing editable VCF position toward the target; intermediate values use a stable genomic or seeded-random whole-position ordering.
- Preview runs as a persistent background job and Apply creates one compact reversible mutation layer on the selected track.
- Unphased alleles are compared without interpreting VCF genotype order as phase.
- Intermediate states are explicitly synthetic editing scenarios rather than evolutionary, reproductive, viability, or health claims.

## Later research

- Cross-genome morphing between samples from the same joint-called VCF, with explicit `0/0` versus `./.`, shared callability scope, same-assembly normalization, and multi-sample provenance.
- Haplotype-aware compound transcript/protein consequences.
- Interaction-aware objectives only where a scientifically validated model supports them.
- GRCh38 resource bundles and carefully explicit assembly migration.
- Splice/regulatory models.
- Sequence-resolved structural variants after the small-variant state model is validated.

BAM/CRAM visualization, read pileups, cloud collaboration, clinical classification, universal health scoring, and claims of biological perfection are not roadmap requirements.
