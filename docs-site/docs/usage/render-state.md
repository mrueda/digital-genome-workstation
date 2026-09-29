# Save and export

**Save a project to continue editing later. Export a track to use its variants or sequence elsewhere.** Consolidation is optional for both.

## Save and reopen

| File menu action | What you keep |
| --- | --- |
| **Save Example as Project** | A named working copy of the bundled example at your chosen location. |
| **Save Project** | Current project and session changes. Named projects also autosave. |
| **Save a Copy** | A separate project snapshot; the original stays open. |
| **Open DGW Project / Open Recent** | Tracks, edits, device settings and saved results from an existing project. |
| **Properties** | The project location and save status. |

A `.dgw` project is a **folder package**. Select the folder ending in `.dgw` when opening it. Keep the whole folder together when moving or backing it up. Genome resources live separately and must remain available for new evaluations.

## Choose an export

| | VCF | FASTA |
| --- | --- | --- |
| Menu | **File → Export VCF** | **File → Export FASTA** |
| Scope | Selected track, all chromosomes | Focused reference interval, at most 50 kb |
| Contents | Effective alleles and genotypes | Reference, chromosome-copy A and chromosome-copy B sequences |
| Typical use | Downstream variant processing | Inspect or use the edited regional sequence |

Choose a new destination outside the project package. DGW refuses to overwrite existing export files.

## Export VCF

The export is sorted, normalized, compressed and indexed. It preserves known phase and unphased calls; loci restored to REF are omitted. It does not copy imported annotations or invent sequencing measurements for edited alleles.

<details>
<summary>Files saved beside the VCF</summary>

| File | Contents |
| --- | --- |
| `.csi` | Variant index. |
| `.evidence.json.gz` | Cached exact-allele predictions and database records, with resource identities. |
| `.device-runs.json.gz` | Recorded device invocations, parameters and outcomes. |
| `.provenance.json` | Edit lineage, resource information and sidecar checksums. |

Evidence and device-run records are project-wide and can include entries outside the exported track. Missing cached evidence means “not cached,” not “no effect.” See [Project format](../technical-details/project-format.md) for the storage details.

</details>

## Export the focused region as FASTA

Each FASTA header identifies the reference interval and track. Indels can make the two reconstructed sequences differ in length.

:::note[Unphased positions]
Unphased heterozygous positions are masked with **N** in both copy sequences and reported in a TSV sidecar. Unphased indels are masked across the REF span rather than assigned to one copy. DGW does not invent which chromosome carries an unphased ALT. Sequence outside supplied calls is reference context, not evidence of a confidently called sample base.
:::

## Consolidation

**Consolidate** makes the current track state the visual baseline. Existing blocks leave the active lane; later edits start above that baseline. Effective alleles and recorded ancestry are preserved, including bypass choices.

You do not need to consolidate to inspect results, compare tracks, save a project or export. [How edit history works](../technical-details/state-model.md).
