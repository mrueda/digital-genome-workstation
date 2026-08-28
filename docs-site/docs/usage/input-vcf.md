# Choose a VCF and Sample

DGW v0.1 creates one project per selected human genome. A multisample cohort VCF is accepted, but only one sample is projected into a project.

## Required input

The VCF must be:

- b37/hs37d5 with reference contig names such as `1`;
- coordinate sorted and REF-consistent;
- left-aligned and minimal;
- biallelic;
- diploid, with `GT` for the selected sample; and
- annotated with a declared SnpEff `ANN` INFO field.

Phased and unphased genotypes are accepted. DGW maps the first and second slots of a phased genotype to chromosome copies A and B. These labels do not mean paternal and maternal: VCF defines no universal parental ordering. DGW preserves `|` or `/` and marks unphased heterozygous alleles as **U · chromosome copy unknown** instead of assigning them to A or B.

DGW v0.1 imports only sequence-resolved SNVs and indels with a 1–49 base length difference. Mixed VCFs may also contain symbolic/CNV alleles such as `CN0` or `<DEL>`, spanning-deletion `*` records, MNVs, and larger alleles; DGW skips those records and reports their count and example loci. Multiallelic records remain a hard error and must be split and normalized first. Production inputs should use BGZF `.vcf.gz`; plain VCF is accepted only to keep small development fixtures reviewable.

## What is frozen

The original multisample VCF remains external and immutable. DGW stores its path and SHA-256, then writes a BGZF/CSI selected-sample artifact containing only non-reference calls. This artifact lets the project reopen if the original path moves, while preserving a warning that source provenance could not be rechecked.

The reconstructed genome means **reference plus the supplied calls**. A missing record does not prove that a position was callable or confirmed homozygous reference.
