# Track, State, and Edit Model

## Two layers

The workspace presents genome tracks, device racks, and edit blocks. The persistence engine represents their biological changes with immutable states and operations. Keeping those layers separate lets DGW offer a direct track workflow without sacrificing reproducibility.

The implemented workspace contract is:

- a read-only source track for the imported selected sample;
- zero or more named experimental tracks;
- one selected track and shared coordinates for visual comparison;
- a device rack for each experimental track; and
- persistent manual and generated edit blocks.

A track represents a complete diploid scenario. Chromosome copies A and B are properties of alleles inside the track, never separate track identities. The labels correspond to phased VCF slots and do not imply maternal/paternal origin. Unphased heterozygous alleles remain chromosome-copy unknown.

## Core identities

`VariantKey` is `(assembly, contig, 1-based position, REF, ALT)`. All alleles are normalized and reference anchored.

`GenomeState` contains an ID, optional parent state, optional edit ID, label, and timestamp. The root state is derived from the source VCF fingerprint, sample, and resource-bundle identity. Child IDs hash their parent and serialized immutable operation.

`EditOperation` targets chromosome copy A, chromosome copy B, or chromosome copy unknown and is one of:

- `SetAllele { key, sourceKey? }`
- `RestoreReference { sourceKey }`
- `CompoundMutationLayer { layerId, positionCount, changeCount }`

The compound form is a small history marker. Its chromosome-copy-specific `SetAllele` and `RestoreReference` children live in an indexed normalized table, not in the marker JSON. This is the bulk equivalent of ordinary edit blocks: one visible operation can represent tens of thousands of exact allele changes.

## Effective state

To construct an effective track, DGW loads the selected sample’s root calls, walks the ancestry from root to the track's head state, expands compound markers only for the requested loci, skips bypassed operation IDs, then applies each remaining operation. Every child of a compound layer inherits its marker ID, so bypass and undo affect the layer atomically. Alleles with neither genome copy active disappear from the effective set.

Operations may not overlap another active allele on the same genome copy, except when `sourceKey` explicitly identifies the allele being replaced. Different alleles from a multiallelic locus remain separate exact-ALT objects. A phased `1|2` assigns them to copies A/B; an unphased `1/2` retains complementary unknown-copy genotype slots, and both remain separate biallelic records when rendered.

## Track operations

Duplicating a track copies its base, head, visible bypass mask, and private baseline exclusions. Subsequent edits branch naturally. Renaming changes track metadata only. Deleting a track marks it archived; reachable audit ancestry remains immutable.

Bypassing a block adds its operation ID to the track's visible bypass mask. During the current application session, applied-device chains and device bypass are held by the workstation; device-generated edit grouping can apply the same bypass operation to every edit ID from that run. Removing a device from the Rack does not remove its already-created genome edits. None of these actions creates a new biological operation or erases one.

## Consolidation

Consolidation first verifies that the current base is an ancestor of the head. It retains all state and edit rows, copies visible bypassed ancestry IDs into the stored track's private baseline-exclusion list, sets the base state to the head state, and clears the visible bypass mask. Because effective reconstruction uses both private and visible bypass IDs, the effective genome is identical before and after consolidation even when some old blocks were bypassed.

Only edits between the new base and a later head are returned as visible blocks. Duplicating the track copies its baseline exclusions. Track VCF rendering also uses the merged bypass set. Consolidation is a state-management operation; it does not create a combined consequence for nearby variants.

## Internal workspace state

The v0.1 engine retains compatibility fields for current state, A/B slots, and focus interval. Track selection mirrors the active track's head and visible bypass mask into the older current-state fields. Moving pointers does not create or mutate biological states. The immutable DAG remains the source of ancestry and audit data, while versions and A/B slots are absent from the primary UI.

## Optimizer runs

The experimental Genome Optimizer produces ordinary `EditOperation` records rather than opaque synthesized sequence. Conservative Minimize emits `RestoreReference`; Conservative Maximize emits source-bounded `SetAllele`; Saturation emits `SetAllele` for the winning non-REF SNV candidate at a selected imported position. This makes every accepted proposal inspectable and bypassable.

The edit note currently records a short objective/direction description. Device settings, generated-edit grouping, input identity, detailed score components, exclusions, and the complete request/plan are not persisted. Formal optimizer-run provenance remains an engineering requirement.
