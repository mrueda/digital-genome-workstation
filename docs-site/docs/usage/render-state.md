# Consolidate and Export a Track

## Consolidation

**Consolidate** moves the selected track's visual base to its current head. Edits between the former base and head disappear from the active lane, while their immutable states and operations remain in the project database. Later changes start a new visible layer above the consolidated baseline.

Consolidation preserves the exact effective genome, including bypass choices. DGW moves bypassed ancestry IDs into a private baseline-exclusion list before it clears the visible bypass list. This prevents a bypassed edit from becoming active merely because its block was flattened. A duplicated consolidated track inherits these exclusions.

Consolidation does not merge per-allele annotations into a combined biological interpretation. It changes track presentation and baseline bookkeeping only.

## Export VCF

Choose **File → Export VCF…**. Its scope is **Current genome track**, analogous to a DAW's whole-song export. DGW materializes the selected track as a BGZF-compressed, CSI-indexed, single-sample VCF. A track does not have to be consolidated before export. Track-based rendering combines private baseline exclusions with currently visible bypass choices, so its genotype matches the same effective state shown in the workspace.

The output is sorted, normalized, and exact-ALT biallelic. Known phase is written with `|`. A phase-unknown single ALT uses `/`; when an imported `1/2` remains two different ALTs, complementary `1/0` and `0/1` rows preserve the two genotype slots without claiming known chromosome copies. Loci restored to reference are omitted. Unchanged observed alleles may preserve valid source ID, QUAL, and FILTER values. Imported consequence/evidence INFO is not copied, and edited or created records never inherit source-ALT annotations or read measurements such as DP or AD.

DGW adds:

- `DGW_ORIGIN` — `observed`, `edited`, or `created`;
- `DGW_EDIT_IDS` — operations contributing to the record;
- `DGW_SOURCE_KEY` — original normalized allele, when applicable; and
- project, internal state, source, resource-bundle, and provenance identifiers in meta headers.

DGW does not insert Variant Consequences, ClinVar, or COSMIC results into the VCF. Those records are resource-versioned evidence, not properties of the genotype file.

A sibling `<output>.evidence.json.gz` contains a snapshot of the project's cached live exact-allele evidence at export time. It records device and resource identities, exact allele keys, status, evaluation time, and coverage. An entry need not be active in the exported track, and absence means “not cached,” not a negative result.

A second sibling, `<output>.device-runs.json.gz`, contains the project's write-once record of completed, failed, and cancelled device invocations. It includes device/version, input state and fingerprint, selection, parameters, resource versions, aggregate result, generated edit/layer IDs, timestamps, and limitations. Clearing the Jobs list does not remove these records.

The `.provenance.json` sidecar records the full edit lineage, effective merged bypass mask, project/resource manifest, render time, scientific limitation, and the paths and SHA-256 values of both compressed sidecars. Its own SHA-256 is embedded in the VCF header. Device-run records are project-wide and therefore can include runs not contributing to the exported track.
