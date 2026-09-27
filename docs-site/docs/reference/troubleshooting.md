# Troubleshooting

## An example will not open

Install resources for that example's assembly through **Settings → Resources**. An app installation alone does not include genome data. [Resource setup](../usage/resources.md).

## A prediction or database is unavailable

Open **Help → About DGW → Tools and resources** to see the paths used by this project. Check that the resource files and their indexes are still present.

A missing optional database does not prevent editing. COSMIC must be [added separately](../usage/resources.md#add-cosmic). Existing projects retain their original resource profile; installing a different profile does not update them.

## Import normalization fails

Check the VCF's assembly and reference alleles against the selected resource profile. DGW normalizes automatically but stops on a true REF mismatch. The source file is unchanged. [Input requirements](../usage/input-vcf.md).

## Import finds no usable alleles

Only strict `FILTER=PASS` records carried as non-reference calls by the selected sample enter the project. `FILTER=.` is excluded. Check the caller's filtering procedure; do not relabel unfiltered records as PASS simply to import them.

Symbolic/CNV alleles such as `CN0` or `<DEL>`, MNVs, gVCF blocks and larger indels are unsupported. Supported ALTs in mixed multiallelic rows are still imported.

## I selected everything, but only see a few variants

**Select all variants · all chromosomes** includes variants outside the visible region. The count shows the device selection; the tracks show the current viewport. Use **Select visible** or **Select alleles in gene** for a smaller scope.

## The DNA changed, but the Monitor says zero

Different ALTs can have the same coarse consequence-impact value. Check that profiling is complete, then use **Track Compare → DNA changes** and **Consequence changes** to see the exact differences. [Understand results](../usage/evaluate-alleles.md).

## Optimizer makes no changes

Check the selected count, eligible/evaluated positions and exclusions. Saturation keeps the current ALT when alternatives tie or do not improve the chosen score. Missing predictions or the ClinVar guard can exclude candidates. Zero changes can be a valid completed run.

## Export says the destination exists

Choose a new filename outside the `.dgw` package. Exports do not overwrite existing files or sidecars. Wait for completion before reading an export; use another destination after an interrupted run.

## The interface becomes blank

Use the recovery screen's diagnostic report and reload the app. If the failure recurs, choose **Reset interface settings and reload**. This resets computer-level display preferences without deleting project edits. The latest interface-only change might not have been saved.

## Installation or launch failed

Check the instructions for [your operating system](../usage/installation.md). Report the DGW version, OS, processor architecture and failing step with the message shown.

<details>
<summary>Linux launch diagnostics and older test installers</summary>

Try the applications-menu launcher. Startup output is normally in `~/.local/share/org.mrueda.dgw/setup-launch.log`. VM graphics warnings alone do not establish the cause of a startup failure.

For reinstalling, use the installer's **Replace existing installation and shortcut** option. The [installer validation guide](../usage/test-installation.md) includes older-build workarounds.

</details>

<details>
<summary>Custom resources or builds from source</summary>

Check the [resource bundle contract](../technical-details/resource-bundle.md): FASTA indexes must belong to the exact file, and consequence GFF3 must match the assembly. An older-than-data database index should be rebuilt if the data changed.

For GTK/WebKitGTK compilation errors, follow the [developer prerequisites](../technical-details/developer-guide.md). System development packages are not ordinary app-installation steps.

</details>
