# Scientific Scope and Limitations

DGW v0.1 is designed to test genome editing and comparison with real annotations, not to provide clinical interpretation.

## Supported

- b37/hs37d5 human reference coordinates.
- One selected diploid sample with phased heterozygous calls.
- Biallelic, sequence-resolved source records.
- SNV edits and insertions/deletions of 1–49 bases.
- Focused haplotype DNA reconstruction.
- Per-allele SnpEff transcript/HGVS consequences.
- Exact normalized-allele evidence from dbNSFP, ClinVar, and COSMIC.

## Deliberately deferred

- Compound/haplotype-aware transcript and protein consequence calculation.
- BAM/CRAM reads, coverage, pileups, and read-backed phasing.
- Structural variants, CNVs, gVCF reference blocks, and multiallelic project input.
- Deep splice models, regulatory models, phenotype ranking, and clinical classification.
- Genome-wide track browsing, cloud accounts, collaboration, and moderation.

An evidence source can be `found`, `no exact match`, `not computed`, `resource unavailable`, or `error`. These states must remain distinct in the interface and exported provenance. In particular, no database match does not imply benignity, and a VCF’s missing positions do not establish callability.
