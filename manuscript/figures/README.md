# Manuscript figures

The current paper is maintained in Google Drive. The PNG files here are the source assets, not screenshots exported back from a document.

## Native application captures — 25 September 2026

DGW v0.1, light mode, native Tauri/WebKit application on a private Xvfb display with `GDK_SCALE=2`. Device captures use 150% interface scale; the workspace uses 100%. Images are cropped at native pixel resolution, without upscaling or mocked results.

| Asset | Use |
| --- | --- |
| `figure-1-workspace.png` | Manuscript Figure 1 and supplement S1; A–F labels |
| `supp-workflow.svg` / `.png` | Supplement S2; editing and evaluation workflow |
| `supp-monitor.png` | Supplement S4; completed Track Monitor |
| `supp-predictor.png` | Supplement S7; selection-based Consequence Predictor |
| `supp-optimizer.png` | Supplement S8; optimizer setup, not a result |
| `supp-compare.png` | Supplement S9; remaining DNA differences |
| `supp-genome.png` | Supplement S10; chromosome overview of those differences |

The synthetic GRCh37 Allele Editing example was opened fresh. On Working track, the seven chromosome-7 loci were randomized with Uniform, Amount 100%, Seed 42 (eight copy-level blocks), then morphed 50% toward Source genome in genomic order (four positions). This reproduces the earlier supplementary example: three differing loci, 12 evaluated mutation operations, total impact delta +1.01 and mean +0.0842. These counts describe different units and must not be equated. The predictor table includes unchanged current alleles at all seven selected loci. Optimizer settings are Impact 70 and maximum five changed positions; no optimization was applied for that screenshot.

The TTN/BRCA2 pilot and its scientific matrix figures are separate experiments. Their data, seeds and figures were not altered by this interface refresh. The retained Allele Roll, Generator and Morph images in the supplement remain valid.

Temporary capture projects, raw captures, document downloads and rendering environments are removed after verification. Final image assets remain here; manuscript and supplement retain their existing Drive IDs.
