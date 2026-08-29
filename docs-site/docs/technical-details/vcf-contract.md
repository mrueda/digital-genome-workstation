# VCF Contract

## Import invariants

- BGZF VCF in production; VCF 4.1+ header.
- b37 assembly and exact hs37d5 contigs.
- 1-based `POS` coordinates at the file, project, and user-interface boundaries.
- sorted, normalized, reference-consistent records.
- biallelic records; supported project alleles are sequence-resolved SNVs and indels with a 1–49 bp length difference.
- diploid GT; phased and unphased heterozygous calls are accepted.
- symbolic/CNV alleles, spanning-deletion records, MNVs, gVCF blocks, and larger sequence alleles are counted and skipped rather than imported.
- imported INFO annotations are optional and ignored by DGW.

Structural checks happen during streaming import. bcftools then REF-checks and normalizes the selected projection; if normalized keys differ, import stops and asks for a normalized source rather than silently changing it.

The editable coordinate set is the set of imported VCF allele positions. Although the registered FASTA provides sequence outside those positions, absence from a conventional VCF is not evidence that the sample was confidently called homozygous reference. Without BAM/CRAM evidence or gVCF callable blocks, DGW therefore does not expose arbitrary-coordinate mutation as an ordinary sample-editing operation.

Skipping applies only to unsupported biallelic allele classes. It happens before genotype parsing because CNV/SV callers may use a different FORMAT contract. Multiallelic records still stop import because selecting or decomposing an ALT would change genotype semantics. The project stores a warning with the skipped source-record count and up to three example loci.

The frozen selected-sample VCF retains the source record for provenance, including any raw INFO. DGW does not parse that INFO into its operational variant model. Effective alleles, edits, devices, the Track Monitor, and the Genome Optimizer use normalized allele identity and live resource results instead.

## Render invariants

- one selected sample;
- original phase semantics preserved: known copy assignments use `|`, copy-unknown heterozygotes use `/`;
- sorted, normalized, biallelic records;
- no record for a locus restored to reference;
- no imported consequence/evidence INFO copied into the rendered VCF;
- no fabricated read measurements for edits; and
- DGW state/resource/provenance metadata; and
- a linked compressed evidence sidecar for cached live device results.

These rules keep the rendered VCF unambiguous: its allele and genotype fields describe the track, while live evidence stays in `<output>.evidence.json.gz`. Unchanged observed records may retain valid source ID, QUAL, and FILTER values, but edited alleles never inherit source-ALT annotations.

## Microarray-derived VCFs

Microarray and direct-to-consumer text files are outside the DGW import contract. They must first be converted to the normalized single-sample VCF described above; beacon2-cbi-tools is the recommended preparation route for its supported formats. The converter owns build identification, strand resolution, ambiguous-probe handling, genotype projection, and normalization. It may also annotate for other workflows, but DGW ignores that INFO. DGW must not infer reference calls from probes that are missing, failed, or absent from a panel.

DGW evidence caching is exact-allele and resource-specific. A candidate ALT that differs from the panel allele remains a new evidence request.
