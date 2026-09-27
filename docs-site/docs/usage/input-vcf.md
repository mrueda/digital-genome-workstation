# Load your VCF

DGW creates a project from **one diploid sample**. You can choose that sample from a cohort VCF. Install the matching [genome resources](resources.md) first.

## Before importing

| Check | Requirement |
| --- | --- |
| Assembly | Match the VCF to GRCh37 (b37/hs37d5) or GRCh38 (hg38). DGW does not lift over coordinates. |
| File | Use a BGZF-compressed `.vcf.gz`. Small plain VCF fixtures are also supported. |
| Genotype | The selected sample must have diploid `GT` calls. Phased and unphased calls are accepted. |
| Filters | Only records whose FILTER is exactly `PASS` enter the project. |
| Alleles | SNVs and sequence-resolved indels with a 1–49 bp length difference. Multiallelic records are accepted. |
| Annotations | Not required. Imported INFO annotations are ignored. |

## Import

1. Choose **File → New Project** or the VCF import option on the landing page.
2. Select the VCF and inspect it.
3. Choose the sample, matching resource profile, project name and destination.
4. Create the project. DGW shows progress through filtering, normalization and indexing.

DGW keeps a read-only **Source genome** and creates an editable **Working track**. It normalizes and sorts a private copy; your input file remains intact.

:::note[Normalization is automatic]
A VCF that is already normalized can still be imported. A true mismatch between REF and the configured reference stops import. Check the assembly rather than forcing the allele to match.
:::

## What happens to the calls?

| Input | DGW behavior |
| --- | --- |
| `0\|1` or `1\|0` | Preserve phased placement as chromosome copy A or B. These labels do not identify parents. |
| `0/1` | Preserve the ALT as **U · chromosome copy unknown**. |
| `1/2` with two ALTs | Keep both exact ALTs and their unphased genotype slots; query each allele separately. |
| `FILTER=.` or failed filters | Exclude and report the count. |
| Symbolic/CNV alleles, MNVs, gVCF blocks or larger indels | Skip unsupported alleles and report warnings. |
| Position absent from the VCF | Provide reference context only; do not infer a confirmed sample genotype. |

## Microarray data

Convert supported vendor text files, such as 23andMe exports, to a reference-consistent diploid VCF first. **beacon2-cbi-tools** provides this preparation route. The converter must resolve assembly and strand orientation; simply changing the extension is insufficient. DGW does not require its annotation step.

See the [VCF contract](../technical-details/vcf-contract.md) for exact normalization and genotype rules, or [Troubleshooting](../reference/troubleshooting.md) if import fails.
