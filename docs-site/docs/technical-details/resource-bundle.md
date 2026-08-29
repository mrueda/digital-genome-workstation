# Resource Bundle

A resource bundle lists one compatible reference/tool core and any locally available Evidence resources. It is the first implementation of a DGW **resource pack**. v0.1 requires `assembly: b37` and exact no-prefix contigs. SnpEff uses the `hg19` genome ID when that optional device resource is configured.

Resource packs provide data and configured tool resources; they are not device code. SnpEff, dbNSFP, ClinVar, and COSMIC appear as Evidence devices in the rack, while their JAR, model, database, and indexed-release entries are resources.

## Required core

- BGZF reference FASTA plus FAI and GZI.
- bcftools, bgzip, and tabix executables.

These paths are required to validate the sample, reconstruct focused sequence, and export a track.

## Optional Evidence resources

- Java executable, SnpEff JAR/config, version, and genome ID.
- Indexed dbNSFP resource with release and license labels.
- Indexed ClinVar resource with release and license labels.
- Indexed COSMIC resource with release and license labels.

The DGW Starter template may show all four Evidence device slots, but a slot with no configured resource is unavailable and inert. It does not stop project creation, editing, or another configured device from running. An optimizer mode that requires a missing device reports that requirement and does not apply a partial edit batch.

The onboarding editor accepts the bundle as JSON and validates the required core plus every optional resource that is present. Indexes older than their data files produce warnings; queryability is tested at use time.

The repository includes `config/local-hs37d5.development.json` for the existing `/media/mrueda/2TBS` stack. It is a development profile, not a redistributable data bundle.

DGW never downloads or includes these databases. COSMIC and every other third-party dataset remain subject to their own terms.

The public JSON contract remains schema version 1. The current contract is local and application-specific. A community-compatible resource-pack manifest still needs stable resource type IDs, versions, checksums, assembly/contig compatibility, license metadata, and matching rules for Device API requirements. External pack installation is not enabled yet.
