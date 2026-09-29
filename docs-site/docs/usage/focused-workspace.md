# Navigate and select

import useBaseUrl from '@docusaurus/useBaseUrl';

**Select a track first, then the variants you want to work on.** The selected-count badge shows the scope passed to Mutation Generator, Genome Optimizer, Track Compare and Consequence Predictor reports.

<figure>
  <a href={useBaseUrl('/img/devices/workspace.png')}><img src={useBaseUrl('/img/devices/workspace.png')} alt="Workspace showing the variant navigator, chromosome overview, tracks and selection controls" /></a>
  <figcaption>Navigate on the left and above the tracks; select alleles in the track area.</figcaption>
</figure>

## Find a gene or position

Use **Go to gene** to search a symbol or Ensembl ID. Choose the intended gene from the results, checking its chromosome and coordinates.

| Action | Result |
| --- | --- |
| Choose a gene | Focus its interval and filter Source Variants to that gene. |
| Select alleles in gene | Select the imported alleles in that interval for devices. |
| Clear the gene filter with **×** | Restore all chromosomes in the left navigator. |
| Expand a chromosome | Browse occupied intervals, then individual source alleles. |
| Go to coordinates | Open a chromosome interval. Positions are 1-based. |

The left navigator lists source alleles. Track lanes show the current track's alleles and edits. A gene with no imported variants has no editable positions.

## Select the scope

| To select… | Use |
| --- | --- |
| One allele | Click its diamond marker. |
| Several visible alleles | Drag across empty space in the active track. |
| Add or remove individual alleles | Control-click; Command-click also works when delivered by the operating system. |
| Add another group | Control/Command-drag. |
| All alleles in the displayed interval | **Select visible**. |
| All active variants on every chromosome | **Select all variants · all chromosomes**. |
| Nothing | **Clear**. |

:::tip[Zoom does not change the selection]
A whole-track selection stays selected when you zoom into a gene. Check the count before running a device. Selecting variants never selects every reference base between them.
:::

## Zoom and make room

| Control | Effect |
| --- | --- |
| **+ / −** or Control/Command + wheel | Zoom the track view. |
| Arrows, Shift + wheel or horizontal trackpad gesture | Pan along the chromosome. |
| **Full chr** | Show the chromosome overview. |
| **Reset view** | Restore the starting view. |
| **Fit allele** or **0** | Return to the focused allele. |
| **Height −/+**, or a track's minimize button | Adjust vertical space. |
| Divider between tracks and rack | Resize the lower pane; double-click to reset. |
| Device's diagonal arrows | Expand a device; **Back to tracks** returns. |

Wide regions show density summaries. Zoom in to see individual alleles. **Settings** controls text scale and light/dark theme; **View** shows or hides panels.

## Review alleles with Transport

Choose **Variants** or **Active edits**, then press Play. DGW opens Evidence, waits for the active predictions and lookups, allows the selected reading time, then advances. Pause stays at the current allele; Stop returns to the review start; Loop repeats the review scope. Playback does not edit DNA.

**Read** offers 1, 3, 5, 10 or 20 seconds (default 5). It changes the pause after results arrive, not the calculation speed; a changed value applies to the next interval.

For help on a control, hover or focus it and read **Context Help** in the Evidence panel. Pin keeps an explanation visible.

Next: [Edit and compare](edit-and-compare.md) or [choose a device](device-guide.md).
