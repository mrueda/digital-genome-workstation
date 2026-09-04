# Choose a VCF and Sample

DGW v0.1 creates one project per selected genome. A multisample cohort VCF is accepted, but only one sample is projected into a project. The current resource contract is human-first and supports b37/hs37d5 and GRCh38/hg38; the workstation model itself is not intended to remain human-specific.

When VCF inspection or project creation takes time, DGW shows the current processing phase and completed steps. Import progress corresponds to real backend boundaries—including PASS projection, normalization, database insertion, compression, and indexing—rather than an estimated animation.

## Required input

The VCF must be:

- b37/hs37d5 with reference contig names such as `1`;
- 1-based positions, as defined by the VCF `POS` column;
- `FILTER=PASS` for every record intended to enter the project;
- REF-consistent with the configured reference;
- one or more sequence-resolved ALT alleles;
- diploid, with `GT` for the selected sample.

The input need not already be left-aligned, minimal, or sorted. DGW first excludes every record whose FILTER field is not exactly `PASS`; `FILTER=.` means filtering was not applied and is not silently treated as passing. DGW reports the excluded count. It then projects the selected sample and runs `bcftools norm -c e` against the configured reference, followed by sorting, before creating the source genome track. A true REF mismatch stops import rather than being silently repaired. Normalization is mandatory because consequence prediction and exact-match Evidence resources identify a variant by its canonical `REF→ALT`, not by position alone. DGW changes only its private project copy and reports how many projected records changed; the source VCF remains untouched.

The VCF may be annotated or unannotated. DGW does not read imported `ANN`, `CSQ`, `CLNSIG`, dbNSFP, COSMIC, or other consequence/evidence INFO fields. They therefore cannot become a current result for a different edited ALT. The same exact allele produces the same DGW result whether those fields were present in the input or not.

Phased and unphased genotypes are accepted. DGW maps the first and second slots of a phased genotype to chromosome copies A and B. These labels do not mean paternal and maternal: VCF defines no universal parental ordering. DGW preserves `|` or `/` and marks unphased heterozygous alleles as **U · chromosome copy unknown** instead of assigning them to A or B.

Multiallelic records are decomposed at import into one exact internal `REF→ALT` allele per supported ALT carried by the selected sample. For example, `A C,G` with `GT=1|2` becomes phased `A→C` on copy A and `A→G` on copy B. With `GT=1/2`, both exact alleles remain copy unknown, but DGW retains their first/second GT slots internally so it does not reinterpret the call as two unrelated `0/1` genotypes. Evidence devices query C and G separately. If an edit makes both slots the same ALT, DGW promotes the result to a homozygous two-copy allele.

DGW v0.1 imports only sequence-resolved SNVs and indels with a 1–49 base length difference. A multiallelic row may mix supported and unsupported ALTs: supported exact alleles are imported and symbolic/CNV alleles such as `CN0` or `<DEL>`, spanning-deletion `*`, MNVs, and larger alleles are skipped with an explicit warning. Production inputs should use BGZF `.vcf.gz`; plain VCF is accepted only to keep small development fixtures reviewable.

## What is frozen

The original multisample VCF remains external and immutable. DGW stores its path and SHA-256, then writes a normalized, sorted BGZF/CSI selected-sample artifact containing only non-reference calls. Multiallelic rows are stored there as exact-ALT GT projections; allele-indexed INFO and FORMAT values are not copied onto a different cardinality because DGW does not use imported annotations. The artifact records the resource-bundle fingerprint used for normalization. Operational variant rows and live evidence use exact internal allele keys. The artifact lets the project reopen if the original path moves, while preserving a warning that source provenance could not be rechecked.

The reconstructed genome means **reference plus the supplied calls**. A missing record does not prove that a position was callable or confirmed homozygous reference.

## Microarray and direct-to-consumer data

DGW does not currently import vendor microarray text files directly. Convert those files into a reference-consistent, diploid single-sample VCF before creating a project. **beacon2-cbi-tools** is the recommended preparation path for supported 23andMe and other microarray inputs. Its annotation step may still be useful for other downstream tools, but DGW ignores those INFO annotations and performs its own exact-allele lookups when needed. DGW handles sequence-allele normalization after conversion; build and strand resolution still belong to the converter.

This conversion is a scientific normalization step, not merely a file-extension change. It must identify the genome build, resolve vendor strand orientation, handle ambiguous A/T and C/G probes conservatively, produce reference-consistent REF/ALT alleles, and preserve unphased genotype semantics. A missing or failed array probe must never be emitted or interpreted as a confirmed homozygous-reference call.

Frequently reused array-panel alleles may be cached by DGW only per exact normalized allele, assembly, device version, and resource release. A different ALT created later is a different cache key and requires its own live evaluation.

A future direct microarray importer should call this preparation layer and return the same validated VCF representation. DGW will not maintain a second internal genome model for array data.
