# Resource Bundle

A resource bundle lists one compatible reference, tool set, and group of annotation databases. It is the first implementation of a DGW **resource pack**. v0.1 requires `assembly: b37`, exact no-prefix contigs, and the SnpEff `hg19` genome ID.

Resource packs provide data and configured tool resources; they are not device code. SnpEff is an analysis device, while its JAR/config/model entries are resources. dbNSFP, ClinVar, and COSMIC are evidence devices, while their indexed release files are resources.

## Registered paths

- BGZF reference FASTA plus FAI and GZI.
- Java executable, SnpEff JAR/config, version, and genome ID.
- bcftools, bgzip, and tabix executables.
- Indexed dbNSFP, ClinVar, and COSMIC resources with release and license labels.

The onboarding editor accepts the bundle as JSON and validates every required path. Indexes older than their data files produce warnings; queryability is tested at use time.

The repository includes `config/local-hs37d5.development.json` for the existing `/media/mrueda/2TBS` stack. It is a development profile, not a redistributable data bundle.

DGW never downloads or includes these databases. COSMIC and every other third-party dataset remain subject to their own terms.

The current JSON contract is local and application-specific. A community-compatible resource-pack manifest still needs stable resource type IDs, versions, checksums, assembly/contig compatibility, license metadata, and matching rules for Device API requirements. External pack installation is not enabled yet.
