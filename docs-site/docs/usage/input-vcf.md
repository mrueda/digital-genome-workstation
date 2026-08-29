# Choose a VCF and Sample

DGW v0.1 creates one project per selected genome. A multisample cohort VCF is accepted, but only one sample is projected into a project. The current bundled resource contract is human-first and uses b37/hs37d5; the workstation model itself is not intended to remain human-specific.

## Required input

The VCF must be:

- b37/hs37d5 with reference contig names such as `1`;
- 1-based positions, as defined by the VCF `POS` column;
- coordinate sorted and REF-consistent;
- left-aligned and minimal;
- biallelic;
- diploid, with `GT` for the selected sample.

The VCF may be annotated or unannotated. DGW does not read imported `ANN`, `CSQ`, `CLNSIG`, dbNSFP, COSMIC, or other consequence/evidence INFO fields. They therefore cannot become a current result for a different edited ALT. The same exact allele produces the same DGW result whether those fields were present in the input or not.

Phased and unphased genotypes are accepted. DGW maps the first and second slots of a phased genotype to chromosome copies A and B. These labels do not mean paternal and maternal: VCF defines no universal parental ordering. DGW preserves `|` or `/` and marks unphased heterozygous alleles as **U · chromosome copy unknown** instead of assigning them to A or B.

DGW v0.1 imports only sequence-resolved SNVs and indels with a 1–49 base length difference. Mixed VCFs may also contain symbolic/CNV alleles such as `CN0` or `<DEL>`, spanning-deletion `*` records, MNVs, and larger alleles; DGW skips those records and reports their count and example loci. Multiallelic records remain a hard error and must be split and normalized first. Production inputs should use BGZF `.vcf.gz`; plain VCF is accepted only to keep small development fixtures reviewable.

## What is frozen

The original multisample VCF remains external and immutable. DGW stores its path and SHA-256, then writes a BGZF/CSI selected-sample artifact containing only non-reference calls. This frozen artifact is the sole project copy of the raw imported INFO. Operational variant rows and live evidence do not use it. The artifact lets the project reopen if the original path moves, while preserving a warning that source provenance could not be rechecked.

The reconstructed genome means **reference plus the supplied calls**. A missing record does not prove that a position was callable or confirmed homozygous reference.

## Microarray and direct-to-consumer data

DGW does not currently import vendor microarray text files directly. Convert those files into the same normalized, biallelic, single-sample VCF contract before creating a project. **beacon2-cbi-tools** is the recommended preparation path for supported 23andMe and other microarray inputs. Its annotation step may still be useful for other downstream tools, but DGW ignores those INFO annotations and performs its own exact-allele lookups when needed.

This conversion is a scientific normalization step, not merely a file-extension change. It must identify the genome build, resolve vendor strand orientation, handle ambiguous A/T and C/G probes conservatively, produce reference-consistent REF/ALT alleles, and preserve unphased genotype semantics. A missing or failed array probe must never be emitted or interpreted as a confirmed homozygous-reference call.

Frequently reused array-panel alleles may be cached by DGW only per exact normalized allele, assembly, device version, and resource release. A different ALT created later is a different cache key and requires its own live evaluation.

A future direct microarray importer should call this preparation layer and return the same validated VCF representation. DGW will not maintain a second internal genome model for array data.
