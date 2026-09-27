# Genome resources

DGW needs a reference genome and supporting data for the assembly you use. Install them separately from the app through **Settings → Resources**.

## Install a supplied resource pack

1. Choose **GRCh37** or **GRCh38**, matching your VCF.
2. Choose a storage folder. The setup screen shows download size and storage guidance.
3. Click **Download and install**. DGW selects the tools for your computer and verifies the download.
4. Choose **Continue to examples** when setup finishes.

| Resource | Used for |
| --- | --- |
| Reference FASTA and indexes | Normalize alleles and reconstruct regional sequence. |
| bcftools / HTSlib tools | VCF processing and consequence prediction. |
| Ensembl annotation and gene index | Transcript consequences and gene navigation. |
| ClinVar | Exact-allele database lookups. |
| COSMIC, optional and separately supplied | Exact-allele somatic-variant records. |

The packs download from the public **dgw-data** release. No GitHub login is needed. For offline use, expand **Other installation options → Install downloaded packages** and select an assembly archive plus the tools archive for your computer.

## Add COSMIC

Under **Settings → Resources → Optional resources · COSMIC**:

1. Select an installed reference profile.
2. Choose your COSMIC `.vcf.gz`; its `.tbi` or `.csi` index must be beside it.
3. Enter the release information and confirm the assembly against the provider's information.
4. Choose **Validate and add COSMIC**.

This creates a new profile for new projects. Select that profile when importing your VCF. The resource files stay where you placed them. DGW does not distribute COSMIC; its own access and license terms apply.

:::note[Existing projects keep their resources]
Installing another pack or adding COSMIC does not silently change the resources recorded by an existing project. **Help → About DGW → Tools and resources** shows what the open project uses.
:::

Keep resource files and their indexes together. See [Troubleshooting](../reference/troubleshooting.md) for missing-resource errors, or [Resource bundle](../technical-details/resource-bundle.md) for advanced configuration.
