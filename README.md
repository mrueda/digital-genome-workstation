<p align="center"><img src="brand/dgw-mark.svg" width="128" alt="Digital Genome Workstation logo"></p>

# Digital Genome Workstation

Digital Genome Workstation (DGW) is a desktop application for editing genome variants and exploring their predicted consequences without changing the original VCF.

Inspired by the mature digital audio workstation ecosystem, DGW lets you duplicate a genome into experimental tracks, apply reversible edits through devices, and compare the results. The aim is a practical genome editor, not a genome browser with a musical appearance.

![DGW workspace with genome tracks, allele editing and devices](docs-site/static/img/dgw-workspace.png)

## What you can do

- Load a VCF, select a sample, and navigate by chromosome, region or gene.
- Edit individual alleles or run bulk operations with Mutation Generator, Genome Optimizer and Genome Morph.
- Inspect predicted consequences and exact database matches, then compare tracks using the Track Monitor and Variant Map.
- Save and reopen projects, export VCFs or regional FASTA, and use the same core operations through an MCP client.

Current resource profiles support human GRCh37 (b37/hs37d5) and GRCh38 (hg38). VCF annotations are not required: DGW normalizes a private copy of the selected sample and evaluates alleles using separately installed resources.

DGW is research software, not a diagnostic tool. Its scores describe independently evaluated alleles, not disease risk or the combined biological effects of several edits.

## Get started

See [Install DGW](docs-site/docs/usage/installation.md) for Linux, macOS and Windows release-installation instructions and current availability. Application installers are still being tested privately; they have not yet been published to a release. Release users do not need development tools.

On first launch, choose a genome and storage folder, then **Download and install** its resources. DGW selects the platform tools automatically. Developers building from source should use the [Developer Guide](docs-site/docs/technical-details/developer-guide.md).

Choose **Open an example** on the landing page to explore a prepared project before importing your own VCF.

## Documentation

The [documentation](docs-site/docs/overview.md) covers the workflow and implementation:

- [Input VCF requirements](docs-site/docs/usage/input-vcf.md)
- [Editing and comparing tracks](docs-site/docs/usage/edit-and-compare.md)
- [Evidence and scoring](docs-site/docs/technical-details/scoring-methods.md)
- [Architecture](docs-site/docs/technical-details/architecture.md) and [MCP access](docs-site/docs/technical-details/mcp-server.md)
- [Development](docs-site/docs/technical-details/developer-guide.md), [testing](docs-site/docs/technical-details/testing.md) and [contributing](CONTRIBUTING.md)

## Author and license

Created and maintained by [Manuel Rueda](https://github.com/mrueda). Citation metadata is in [CITATION.cff](CITATION.cff).

Copyright © 2026 Manuel Rueda. Licensed under [Apache 2.0](LICENSE). External tools and biological resources retain their own licenses.
