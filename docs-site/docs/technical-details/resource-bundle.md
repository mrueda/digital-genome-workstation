# Resource Bundle

A resource bundle lists one compatible reference/tool core and any locally available Evidence resources. It is the first implementation of a DGW **resource pack**. v0.1 accepts `assembly: b37` and `assembly: hg38`. The project uses the reference FASTA naming convention internally and translates safe `1`/`chr1` and mitochondrial aliases for resources that declare another `contigStyle`. This changes names only, never coordinates or assemblies.

Resource packs provide data and configured tool resources; they are not device code. Variant Consequences, dbNSFP, ClinVar, and COSMIC appear as Evidence devices in the rack, while the Ensembl GFF3 and indexed database releases are resources.

## Required core

- BGZF reference FASTA plus FAI and GZI.
- One version-matched bcftools, bgzip, and tabix toolchain.

These paths are required to validate the sample, reconstruct focused sequence, and export a track.

## Optional consequence resource

- An assembly-matched Ensembl GFF3 for transcript consequence prediction with `bcftools csq`.

The Variant Consequences device and the Genome Optimizer's Saturation mode require this resource. A project can still be created, edited, saved, and exported without it.

## Optional database Evidence resources

- Indexed dbNSFP resource with release and license labels.
- Indexed ClinVar resource with release and license labels.
- Indexed COSMIC resource with release and license labels.

## Optional gene annotation

Gene navigation uses an assembly-matched GTF plus a compact DGW SQLite gene index. The first contract indexes only `gene` features: stable gene ID, symbol when present, genomic interval, strand, and biotype. Transcript and exon rows remain in the source GTF but are deliberately outside the first gene-navigation scope.

The gene resource records the assembly, contig style, source URL, release, checksum, and license label. DGW rejects an assembly mismatch and translates the gene index's declared contig convention to the project reference convention. GTF and VCF coordinates are both handled as 1-based inclusive coordinates.

The repository includes reusable descriptors for the locally installed Ensembl human resources:

- `config/ensembl-grch37.87.genes.json`
- `config/ensembl-grch38.116.genes.json`

Indexes can be rebuilt without loading transcript rows into a project:

```bash
cargo run -p dgw-core --example build_gene_index -- \
  genes.gtf.gz genes.sqlite GRCh37 "Ensembl 87" no_chr_prefix \
  https://example.org/genes.gtf.gz
```

The DGW Starter template shows the four Evidence device slots. A consequence or database slot with no configured resource is unavailable and inert. It does not stop project creation, editing, or another configured device from running. An optimizer mode that requires a missing device reports that requirement and does not apply a partial edit batch.

The onboarding editor accepts the bundle as JSON and validates the required core plus every optional resource that is present. Evidence indexes older than their data files produce warnings; the gene index is also checked against its GTF fingerprint, assembly, and contig style.

The repository includes `config/local-hs37d5.development.json` and `config/local-hg38.development.json` for the existing `/media/mrueda/2TBS` stack. They are development profiles, not redistributable data bundles. The selected profile and fingerprint are pinned in each project; changing an existing project's assembly is not supported.

DGW never downloads or includes these databases. COSMIC and every other third-party dataset remain subject to their own terms.

The public JSON contract remains schema version 1. The current contract is local and application-specific. A community-compatible resource-pack manifest still needs stable resource type IDs, versions, checksums, assembly/contig compatibility, license metadata, and matching rules for Device API requirements. External pack installation is not enabled yet.
