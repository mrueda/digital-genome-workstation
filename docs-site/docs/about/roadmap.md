# Roadmap

## v0.1 foundation — Working engine

- b37 annotated VCF import and one selected sample, with phased and unphased GT support.
- Focused two-copy DNA reconstruction with explicit copy-unknown alleles.
- Immutable SNV/short-indel edits, branches, bypass, and internal A/B pointers.
- Per-allele SnpEff plus exact dbNSFP, ClinVar, and COSMIC evidence.
- Normalized VCF render with full provenance.
- Linux and macOS desktop development path.

## Implemented — Track workspace

- A genome track is the primary object: one complete diploid scenario containing homologous chromosome copies A and B, with parental origin unknown unless explicitly supplied.
- The imported sample is a read-only source track.
- Experimental tracks can be duplicated, renamed, selected, compared, hidden, and archived.
- Manual and generated changes are persistent, selectable edit blocks over shared focused coordinates.
- Each editable track has a device rack with edit-level and current-session device bypass.
- Version history and A/B state slots are out of the primary workflow while the immutable DAG remains internal provenance.
- Consolidation moves the visual base to the current head, retains complete ancestry, and privately preserves bypassed baseline edits.
- Track-based VCF export merges private baseline exclusions and visible bypass choices.

## Implemented experimental prototype — Genome Optimizer

- Alternate-allele burden and additive predicted-impact burden objectives.
- Minimize restores eligible active exact-source alleles to reference.
- Maximize only reintroduces exact original-source alleles absent from the current track; it is not disease maximization.
- Impact, recognized ClinVar, and exact-source-membership weights for predicted-impact burden.
- Maximum-edits bound, deterministic ranking, and explicit candidate exclusions.
- Proposals become normal visible, reversible edit blocks with individual evidence review.
- The interface reports the additive-score limitation: no interactions, compound effects, penetrance, or whole-genome model.

## Engineering next

- Persist device settings and device-to-edit ownership.
- Add formal optimizer-run provenance: input identity, scoring contract/version, request, components, exclusions, output edit IDs, and uncertainty.
- Include track identity, consolidation details, and device/run records in export provenance.
- Publish versioned DGW Device API schemas for editing, analysis, and evidence devices.
- Move built-in Genome Optimizer, SnpEff, dbNSFP, ClinVar, and COSMIC adapters behind the same conformance-tested host boundary.
- Present built-in editing, analysis, and evidence devices through one generic rack lifecycle and UI.
- Formalize resource-pack manifests separately from executable device manifests.
- Define external-device isolation, permissions, cancellation, failure handling, and reproducibility before enabling third-party execution.
- Add community package discovery, installation, upgrades, and removal only after that trust boundary is implemented.
- Project/resource migration tooling and stronger content fingerprints.
- Richer transcript/exon focus and sequence-difference presentation.
- Pluggable evaluators and configurable evidence summaries.
- Redistribution-safe test bundles and packaged desktop releases.

## Later research

- Haplotype-aware compound transcript/protein consequences.
- Interaction-aware objectives only where a scientifically validated model supports them.
- GRCh38 resource bundles and carefully explicit assembly migration.
- Splice/regulatory models.
- Sequence-resolved structural variants after the small-variant state model is validated.

BAM/CRAM visualization, read pileups, cloud collaboration, clinical classification, a universal health score, disease maximization, and claims of a disease-free genome are not roadmap requirements.
