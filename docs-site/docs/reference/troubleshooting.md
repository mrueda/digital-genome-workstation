# Troubleshooting

## Tauri cannot find GTK or WebKitGTK

On Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev
```

Then run `cargo check -p dgw-desktop` again.

## The bundle validator reports a missing path

Expand **Resource bundle** on the onboarding screen and update the JSON. Paths are local and machine-specific. The supplied development profile expects `/media/mrueda/2TBS`. Reference and VCF-tool paths are required. A missing optional SnpEff, dbNSFP, ClinVar, or COSMIC resource should leave only that device unavailable; remove or repair its configuration rather than inventing a placeholder file.

## What does “U · chromosome copy unknown” mean?

The VCF uses an unphased heterozygous genotype such as `0/1`. DGW accepts and preserves the allele but does not place it on chromosome copy A or B inside the genome track. It is evaluated individually and remains unphased when rendered.

## Import says the VCF is not normalized

Normalize and split upstream against the same hs37d5 reference, for example with bcftools `norm -f ... -m -both`. Reannotation is not required for DGW.

## Reference rows are empty

Confirm that the FASTA is BGZF-compressed and that both `.fai` and `.gzi` belong to the exact file. Contig names must match the VCF.

## SnpEff times out on the first request

The cold model load can take 8–15 seconds and about 3 GB RAM. Confirm Java can access the configured JAR, config, and hg19 data directory. A failed worker is restarted once; failures are not cached.

## An index is older than its database

DGW warns but tests the index when queried. Rebuild it before relying on the bundle if data was replaced after indexing.

## The VCF contains `CN0`, `<DEL>`, or another structural allele

DGW v0.1 does not edit copy-number or structural variants. During inspection it counts these records separately, and during project creation it skips them before interpreting their genotype fields. The project warning records the source-record count and example loci. Supported biallelic SNVs and 1–49 bp indels in the same VCF continue to import.

Multiallelic records are different: split and normalize those before import because DGW will not guess how the selected genotype should be decomposed across ALT alleles.
