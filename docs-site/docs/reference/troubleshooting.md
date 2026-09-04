# Troubleshooting

## Tauri cannot find GTK or WebKitGTK

On Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev
```

Then run `cargo check -p dgw-desktop` again.

## The bundle validator reports a missing path

Expand **Resource bundle** on the onboarding screen and update the JSON. Paths are local and machine-specific. The supplied development profile expects `/media/mrueda/2TBS`. The reference and version-matched VCF tools are required for a project. An assembly-matched consequence GFF3 is required only for Variant Consequences and Saturation. A missing optional consequence or database resource should leave only the dependent device unavailable; remove or repair its configuration rather than inventing a placeholder file.

For an open project, use **Help → About DGW → Tools and resources**. DGW checks that registered files and indexes still exist and runs the configured bcftools executable to compare its reported version with the project profile. **Ready** means the registered paths passed this immediate check; it does not independently validate the scientific content of a third-party database.

## The interface becomes blank

A render failure should now open DGW's recovery screen instead of leaving a blank window. Copy the diagnostic report, then reload the application. If the same interface failure happens immediately, use **Reset interface settings and reload**. This removes only computer-level display preferences; it does not delete the `.dgw` package or its genome edits. The last interface-only state change may not have reached the project's session record before the failure.

## What does “U · chromosome copy unknown” mean?

The VCF uses an unphased heterozygous genotype such as `0/1`. DGW accepts and preserves the allele but does not place it on chromosome copy A or B inside the genome track. It is evaluated individually and remains unphased when rendered.

## Import normalization fails

DGW normally left-aligns and minimizes the selected-sample project copy automatically. A failure here usually means the VCF build, contig names, or REF alleles do not match the configured reference, or the configured `bcftools` path cannot run. Check those resources; reannotation is not required. The original VCF is never changed.

## Import finds no usable alleles

DGW v0.1 imports only strict `FILTER=PASS` records carried as non-reference genotypes by the selected sample. Records marked with a failed filter or `FILTER=.` are counted but excluded. Apply an appropriate, documented calling/QC filter upstream rather than relabelling unfiltered records as PASS merely to make them importable.

## Reference rows are empty

Confirm that the FASTA is BGZF-compressed and that both `.fai` and `.gzi` belong to the exact file. Contig names must match the VCF.

## Variant Consequences fails

Confirm that the configured bcftools executable includes `csq`, the reference FASTA indexes belong to the exact FASTA, and the Ensembl GFF3 matches the project assembly. GRCh38 model loading can take several seconds and about 800 MB in the current development environment. Failures are not cached.

A `.dgw` project pins the resource profile used when it was created. A development project created before the Variant Consequences migration has no Ensembl consequence descriptor and therefore shows this device as unavailable; opening the package does not silently rewrite its scientific resource identity. Reimport the source VCF with the updated assembly profile for now. An explicit resource-rebinding workflow is planned for projects that must retain their existing edits.

## An index is older than its database

DGW warns but tests the index when queried. Rebuild it before relying on the bundle if data was replaced after indexing.

## The VCF contains `CN0`, `<DEL>`, or another structural allele

DGW v0.1 does not edit copy-number or structural variants. During inspection it counts wholly unsupported records separately. During project creation it decomposes multiallelic rows, imports supported sequence-resolved SNVs and 1–49 bp indels, and reports skipped ALT alleles with examples. The selected sample's GT determines which exact ALTs enter the project.
