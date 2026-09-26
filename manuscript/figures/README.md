# Manuscript figures

The current paper is maintained in Google Drive. The PNG files here are the source assets, not screenshots exported back from a document.

## Publication refresh — 26 September 2026

`figure-1-workspace.png` is the shared source for manuscript Figure 1 and supplement S1. It now shows the current Evidence labels, compact Consequence Predictor and File-menu-era workspace. The same fictional example and operations below reproduce the existing Monitor values. Native capture uses a private 3840×2160 Xvfb display, `GDK_SCALE=2` and light mode. The 3760×1800 workspace uses 100% interface scale and is cropped above the status footer, without resampling; A–F labels and a short key are added on a white canvas.

Detailed UI screenshots now belong in `docs-site/static/img/devices/`, with explanations in `docs-site/docs/usage/device-guide.md`. The supplement retains the workspace image and workflow diagram, but no longer duplicates the device screenshots. Scientific pilot figures and equations are unchanged. Device captures use a 2800×2100 native window: 120% interface scale for Generator/Morph, 100% for prediction, optimization and comparison tables. Monitor, Evidence and Allele Roll are native-resolution panel crops. `scripts/prepare-publication-screenshots.py` records the crop boxes and Figure 1 labels.

## Native application captures — 25 September 2026

DGW v0.1, light mode, native Tauri/WebKit application on a private Xvfb display with `GDK_SCALE=2`. Device captures use 150% interface scale; the workspace uses 100%. Images are cropped at native pixel resolution, without upscaling or mocked results.

| Asset | Use |
| --- | --- |
| `figure-1-workspace.png` | Manuscript Figure 1 and supplement S1; A–F labels |
| `supp-workflow.svg` / `.png` | Supplement S2; editing and evaluation workflow |
| `../../docs-site/static/img/devices/monitor.png` | Device guide; completed Track Monitor |
| `../../docs-site/static/img/devices/predictor.png` | Device guide; selection-based Consequence Predictor |
| `../../docs-site/static/img/devices/optimizer.png` | Device guide; optimizer setup, not a result |
| `../../docs-site/static/img/devices/compare.png` | Device guide; remaining DNA differences |
| `../../docs-site/static/img/devices/genome.png` | Device guide; chromosome overview of those differences |

The synthetic GRCh37 Allele Editing example was opened fresh. On Working track, the seven chromosome-7 loci were randomized with Uniform, Amount 100%, Seed 42 (eight copy-level blocks), then morphed 50% toward Source genome in genomic order (four positions). This reproduces the earlier supplementary example: three differing loci, 12 evaluated mutation operations, total impact delta +1.01 and mean +0.0842. These counts describe different units and must not be equated. The predictor table includes unchanged current alleles at all seven selected loci. Optimizer settings are Impact 70 and maximum five changed positions; no optimization was applied for that screenshot.

The TTN/BRCA2 pilot and its scientific matrix figures are separate experiments. Their data, seeds and figures were not altered by this interface refresh. Allele Roll, Generator and Morph have also been recaptured for the Device Guide.

Temporary capture projects, raw captures, document downloads and rendering environments are removed after verification. Final image assets remain here; manuscript and supplement retain their existing Drive IDs.
