# VCF Contract

## Import invariants

- BGZF VCF in production; VCF 4.1+ header.
- b37 assembly and exact hs37d5 contigs.
- 1-based `POS` coordinates at the file, project, and user-interface boundaries.
- only records with `FILTER=PASS` enter the project; failed filters and `FILTER=.` are excluded and counted before projection.
- reference-consistent records; the source need not already be left-aligned, minimal, or sorted.
- one or more ALT alleles per record; supported project alleles are sequence-resolved SNVs and indels with a 1–49 bp length difference.
- diploid GT; phased and unphased heterozygous calls are accepted.
- symbolic/CNV alleles, spanning-deletion records, MNVs, gVCF blocks, and larger sequence alleles are counted and skipped rather than imported.
- imported INFO annotations are optional and ignored by DGW.

Structural checks and strict-PASS filtering happen during streaming import. DGW writes a temporary exact-ALT projection for the selected sample, runs `bcftools norm -c e -f` against the configured reference, and sorts the normalized result. A changed canonical allele is recorded as an import warning rather than rejected. The original source file is never rewritten. A true REF/build mismatch or a normalization-tool failure stops import; DGW does not use `-c s` to repair it silently.

The editable coordinate set is the set of imported VCF allele positions. Although the registered FASTA provides sequence outside those positions, absence from a conventional VCF is not evidence that the sample was confidently called homozygous reference. Without BAM/CRAM evidence or gVCF callable blocks, DGW therefore does not expose arbitrary-coordinate mutation as an ordinary sample-editing operation.

DGW decomposes a multiallelic source row into one exact internal allele for each supported ALT carried by the selected GT. A phased `1|2` maps the first and second ALT to chromosome copies A and B. An unphased `1/2` produces two copy-unknown alleles while retaining their `/` slot internally; it is not converted into two unrelated `0/1` calls. Unsupported ALTs are skipped individually. Wholly unsupported records are skipped before genotype parsing because CNV/SV callers may use a different FORMAT contract. The project warning includes the skipped-allele count and example loci.

The frozen selected-sample VCF contains exact projected alleles for the chosen sample. A multiallelic row is represented as normalized biallelic GT-only rows because allele-indexed INFO/FORMAT values cannot be copied safely after changing ALT cardinality. The original source path and SHA-256 remain in the manifest. Effective alleles, edits, devices, the Track Monitor, and the Genome Optimizer use normalized allele identity and live resource results.

## Render invariants

- one selected sample;
- original phase semantics preserved: known copy assignments use `|`, copy-unknown heterozygotes use `/`;
- sorted, normalized, exact-ALT biallelic records; a decomposed unphased `1/2` retains complementary `1/0` and `0/1` slot projections;
- no record for a locus restored to reference;
- no imported consequence/evidence INFO copied into the rendered VCF;
- no fabricated read measurements for edits; and
- DGW state/resource/provenance metadata; and
- a linked compressed evidence sidecar for cached live device results.

These rules keep the rendered VCF unambiguous: its allele and genotype fields describe the track, while live evidence stays in `<output>.evidence.json.gz`. Unchanged observed records may retain valid source ID, QUAL, and FILTER values, but edited alleles never inherit source-ALT annotations.

## Microarray-derived VCFs

Microarray and direct-to-consumer text files are outside the DGW import contract. They must first be converted to a reference-consistent diploid single-sample VCF; beacon2-cbi-tools is the recommended preparation route for its supported formats. The converter owns build identification, strand resolution, ambiguous-probe handling, and genotype projection. DGW then owns canonical sequence-allele normalization of its project copy. The converter may also annotate for other workflows, but DGW ignores that INFO. DGW must not infer reference calls from probes that are missing, failed, or absent from a panel.

DGW evidence caching is exact-allele and resource-specific. A candidate ALT that differs from the panel allele remains a new evidence request.
