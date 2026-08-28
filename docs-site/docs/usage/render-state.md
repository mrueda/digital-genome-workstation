# Consolidate and Export a Track

## Consolidation

**Consolidate** moves the selected track's visual base to its current head. Edits between the former base and head disappear from the active lane, while their immutable states and operations remain in the project database. Later changes start a new visible layer above the consolidated baseline.

Consolidation preserves the exact effective genome, including bypass choices. DGW moves bypassed ancestry IDs into a private baseline-exclusion list before it clears the visible bypass list. This prevents a bypassed edit from becoming active merely because its block was flattened. A duplicated consolidated track inherits these exclusions.

Consolidation does not merge per-allele annotations into a combined biological interpretation. It changes track presentation and baseline bookkeeping only.

## Export VCF

Choose **File → Export VCF…**. Its scope is **Current genome track**, analogous to a DAW's whole-song export. DGW materializes the selected track as a BGZF-compressed, CSI-indexed, single-sample VCF. A track does not have to be consolidated before export. Track-based rendering combines private baseline exclusions with currently visible bypass choices, so its genotype matches the same effective state shown in the workspace.

The output is sorted, normalized, and biallelic. Known phase is written with `|`; phase-unknown heterozygous alleles remain `0/1`. Loci restored to reference are omitted. Unchanged observed records preserve their source INFO fields. Edited and created records never inherit experimental measurements such as DP or AD.

DGW adds:

- `DGW_ORIGIN` — `observed`, `edited`, or `created`;
- `DGW_EDIT_IDS` — operations contributing to the record;
- `DGW_SOURCE_KEY` — original normalized allele, when applicable;
- `DGW_EVAL_STATUS` — whether a matching live result is cached; and
- project, internal state, source, resource-bundle, and provenance identifiers in meta headers.

A sibling `.provenance.json` records the full edit lineage, effective merged bypass mask, project/resource manifest, render time, and scientific limitation. Its SHA-256 is embedded in the VCF header.

The current export provenance does not distinguish private baseline exclusions from visible bypass choices, identify a formal consolidation event, or include Genome Optimizer settings and plan details. Track/device provenance needs a later schema and sidecar extension.
