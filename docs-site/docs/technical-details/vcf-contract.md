# VCF Contract

## Import invariants

- BGZF VCF in production; VCF 4.1+ header.
- b37 assembly and exact hs37d5 contigs.
- sorted, normalized, reference-consistent records.
- biallelic records; supported project alleles are sequence-resolved SNVs and indels with a 1–49 bp length difference.
- diploid GT; phased and unphased heterozygous calls are accepted.
- symbolic/CNV alleles, spanning-deletion records, MNVs, gVCF blocks, and larger sequence alleles are counted and skipped rather than imported.
- SnpEff `ANN` declared in the header.

Structural checks happen during streaming import. bcftools then REF-checks and normalizes the selected projection; if normalized keys differ, import stops and asks for a normalized source rather than silently changing it.

The editable coordinate set is the set of imported VCF allele positions. Although the registered FASTA provides sequence outside those positions, absence from a conventional VCF is not evidence that the sample was confidently called homozygous reference. Without BAM/CRAM evidence or gVCF callable blocks, DGW therefore does not expose arbitrary-coordinate mutation as an ordinary sample-editing operation.

Skipping applies only to unsupported biallelic allele classes. It happens before genotype parsing because CNV/SV callers may use a different FORMAT contract. Multiallelic records still stop import because selecting or decomposing an ALT would change genotype and annotation semantics. The project stores a warning with the skipped source-record count and up to three example loci.

## Render invariants

- one selected sample;
- original phase semantics preserved: known copy assignments use `|`, copy-unknown heterozygotes use `/`;
- sorted, normalized, biallelic records;
- no record for a locus restored to reference;
- source INFO retained only for unchanged observed alleles;
- no fabricated read measurements for edits; and
- DGW state/resource/provenance metadata.

These rules make a rendered VCF suitable as an explicit downstream artifact while preserving which calls were observed and which were hypothetical.
