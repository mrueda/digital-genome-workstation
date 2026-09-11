# Resource Bundle

A resource bundle lists one compatible reference/tool core and any locally available Evidence resources. It is the first implementation of a DGW **resource pack**. v0.1 accepts `assembly: b37` and `assembly: hg38`. The project uses the reference FASTA naming convention internally and translates safe `1`/`chr1` and mitochondrial aliases for resources that declare another `contigStyle`. This changes names only, never coordinates or assemblies.

Resource packs provide data and configured tool resources; they are not device code. Variant Consequences, ClinVar, and COSMIC appear as Evidence devices in the rack, while the Ensembl GFF3 and indexed database releases are resources.

## Required core

- BGZF reference FASTA plus FAI and GZI.
- One version-matched bcftools, bgzip, and tabix toolchain.

These paths are required to validate the sample, reconstruct focused sequence, and export a track.

## Optional consequence resource

- An assembly-matched Ensembl GFF3 for transcript consequence prediction with `bcftools csq`.

The Variant Consequences device and the Genome Optimizer's Saturation mode require this resource. A project can still be created, edited, saved, and exported without it.

## Optional database Evidence resources

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

The DGW Starter template shows the three Evidence device slots. A consequence or database slot with no configured resource is unavailable and inert. It does not stop project creation, editing, or another configured device from running. An optimizer mode that requires a missing device reports that requirement and does not apply a partial edit batch.

The onboarding editor accepts the bundle as JSON and validates the required core plus every optional resource that is present. Evidence indexes older than their data files produce warnings; the gene index is also checked against its GTF fingerprint, assembly, and contig style.

The repository includes `config/local-hs37d5.development.json` and `config/local-hg38.development.json` for the existing `/media/mrueda/2TBS` stack. They are development profiles, not redistributable data bundles. The selected profile and fingerprint are pinned in each project; changing an existing project's assembly is not supported.

DGW keeps application code, platform tools, and assembly data as separate artifacts. The current `dgw-data` release set contains:

- one small bcftools/bgzip/tabix package for each supported platform;
- one shared GRCh37 data package and one shared GRCh38 data package;
- a release index that pins the archive checksum, internal-manifest checksum and unpacked size.

Each data package contains the BGZF reference plus indexes, an archived ClinVar VCF plus index, the Ensembl GTF plus DGW gene index, and the Ensembl GFF3 used by `bcftools csq`. COSMIC is excluded and remains user-supplied. Data and tools retain their upstream terms; they are not relicensed under DGW's Apache license.

In **Settings → Resources**, **Install downloaded packages** accepts exactly one assembly-data archive and the tool archive for the current computer. DGW recognizes only artifacts pinned in its release index. It verifies the complete archive, extracts into private staging, rejects links, path escapes, duplicates and undeclared files, then verifies every extracted file against the package manifest. Only a complete bundle is registered. Retrying reuses a verified extraction and never replaces a changed file.

The installed project descriptor uses relative paths within that bundle. Existing projects keep their pinned resource descriptor; installing a newer resource package does not silently change them.

### Automatic downloads

The installer builds one choice per assembly using the data archive and the tools for the current operating system and processor. Archive identities and checksums come from the bundled `config/resource-artifacts.json`; the app does not trust a downloaded index to replace those checksums.

`config/resource-catalog.json` points to the public resource release. Anonymous access and the Linux ARM64 tools download checksum were verified on 2026-09-11. The application repository remains private. The bundled configuration is:

```json
{
  "schemaVersion": 1,
  "downloadBaseUrl": "https://github.com/mrueda/dgw-data/releases/download/resources-r1"
}
```

Rebuild the app after changing this bundled configuration. DGW appends each pinned archive filename to that URL and requires HTTPS without embedded credentials. It does not use the user's GitHub login or a repository token.

Automatic installation downloads and checks each archive, extracts and verifies its manifest and files, then composes the same resource descriptor as manual installation. Registration occurs only after resource validation succeeds. A retry reuses verified extracted packages; partial downloads restart. A changed existing descriptor is rejected, not overwritten.

Gene SQLite indexes are read as immutable resources, so queries do not create WAL/SHM files inside an installed package. Finish writing and checkpoint an index before registering it; DGW rejects a nonempty WAL rather than ignoring pending changes.

The public JSON contract remains schema version 1. Package manifests already record stable IDs, versions, checksums, assembly/contig compatibility, source URLs and license labels. A broader community resource-pack contract still needs matching rules for third-party Device API requirements; external device installation is not enabled yet.
