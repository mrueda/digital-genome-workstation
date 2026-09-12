# Application Note scope freeze

This is the feature boundary for the first DGW manuscript. New features should not enter the paper unless they correct scientific validity, reproducibility, data loss, or installation failure.

## In scope

- Desktop editing of one selected diploid VCF sample on human GRCh37 or GRCh38.
- PASS filtering, multiallelic decomposition, reference-backed normalization, and explicit phased or unphased genotype handling.
- A protected source track, editable track copies, reversible manual edits, bypass, Undo/Redo, consolidation, Save/Save Copy, VCF export, and regional FASTA export.
- Mutation Generator randomization, Genome Morph between tracks from the same imported sample, and Genome Optimizer Conservative and Saturation modes.
- Live `bcftools csq --local-csq` predictions using an assembly-matched Ensembl GFF3, plus exact-allele ClinVar and optional COSMIC evidence.
- Track Monitor, Variant Map, gene navigation, bounded rendering, persistent background jobs, compact bulk layers, and immutable terminal device-run records.
- The local MCP command interface as an alternative access route to the same Rust core.
- Validation with synthetic fixtures, both assembly profiles, and the public HG00103 exome journey.

## Out of scope

- BAM/CRAM inspection, read-level editing, and editing reference positions absent from the input VCF.
- Joint or phase-aware prediction of the combined effect of several edited alleles.
- Disease-risk, penetrance, viability, fitness, or clinical decision models.
- Cross-sample or cross-genome morphing, arbitrary branch merges, and third-party device installation or sandboxed execution.
- Structural variants, gVCF reference blocks, native Windows ARM support, automatic application updates, and claims of complete platform coverage.
- Developer ID/notarized macOS distribution and signed Windows distribution until those release processes exist.

## Submission boundary

The manuscript may report implemented behavior and completed validation only. One additional repeated public-data benchmark, a real Windows installation test, public source/resource releases, and an archival DOI remain release/submission tasks. They do not justify expanding the feature set.
