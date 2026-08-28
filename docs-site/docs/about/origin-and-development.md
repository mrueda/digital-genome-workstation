# Origin and Development

Digital Genome Workstation grew from [mrueda](https://github.com/mrueda)'s idea of applying the non-destructive working model of digital audio workstations to human genome variation.

The central analogy is operational. The selected individual is a read-only source genome track. A user duplicates that track, applies devices, sees persistent edit blocks, bypasses changes, compares tracks, and consolidates only by explicit choice. Homologous chromosome copies A and B remain inside each complete diploid track; the labels do not imply parental origin. The immutable state DAG stays behind the interface as provenance.

The device-rack idea also provides a home for bounded generative tools. The implemented experimental Genome Optimizer uses faders to weight imported impact, recognized ClinVar classification, and exact source membership, plus a knob that limits edits. Its output remains discrete source-bounded alleles represented by ordinary reversible edit blocks. DGW is not an attempt to make sequence behave like audio or to reproduce a music application's appearance.

The rack extends beyond editing: SnpEff is an analysis device, while dbNSFP, ClinVar, and COSMIC are evidence devices. “VST-like” is only the conceptual inspiration for a compatible device rack. DGW compatibility will come from a versioned structured Device API under host control, not from an audio plug-in format. Device code and biological resource packs remain separate so community software can evolve without bundling or relicensing large external databases.

This is an **independent side project developed by mrueda in his free time**. Human genomes come first. The first working version uses the existing b37/hs37d5, SnpEff, dbNSFP, ClinVar, and COSMIC resources already maintained for related bioinformatics work.

The project is created and maintained by [mrueda](https://github.com/mrueda).
