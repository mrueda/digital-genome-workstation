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

## Import normalization fails

DGW normally left-aligns and minimizes the selected-sample project copy automatically. A failure here usually means the VCF build, contig names, or REF alleles do not match the configured reference, or the configured `bcftools` path cannot run. Check those resources; reannotation is not required. The original VCF is never changed.

## Import finds no usable alleles

DGW v0.1 imports only strict `FILTER=PASS` records carried as non-reference genotypes by the selected sample. Records marked with a failed filter or `FILTER=.` are counted but excluded. Apply an appropriate, documented calling/QC filter upstream rather than relabelling unfiltered records as PASS merely to make them importable.

## Reference rows are empty

Confirm that the FASTA is BGZF-compressed and that both `.fai` and `.gzi` belong to the exact file. Contig names must match the VCF.

## SnpEff times out on the first request

The cold model load can take 8–15 seconds and about 3 GB RAM. Confirm Java can access the configured JAR, config, and hg19 data directory. A failed worker is restarted once; failures are not cached.

## An index is older than its database

DGW warns but tests the index when queried. Rebuild it before relying on the bundle if data was replaced after indexing.

## The VCF contains `CN0`, `<DEL>`, or another structural allele

DGW v0.1 does not edit copy-number or structural variants. During inspection it counts wholly unsupported records separately. During project creation it decomposes multiallelic rows, imports supported sequence-resolved SNVs and 1–49 bp indels, and reports skipped ALT alleles with examples. The selected sample's GT determines which exact ALTs enter the project.
