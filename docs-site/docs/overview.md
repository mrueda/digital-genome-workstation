# Start here

**What would change if this sample had a different allele?** Digital Genome Workstation lets you edit variants, inspect predictions and database records, and compare alternatives while keeping the source VCF intact.

import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';

<div className="dgw-guide-grid">
  <Link className="dgw-guide-card" to="/docs/usage/installation"><strong>Install DGW</strong><span>Linux, macOS or Windows, then genome resources.</span></Link>
  <Link className="dgw-guide-card" to="/docs/usage/quickstart"><strong>Try an example</strong><span>Make one edit and see what changes.</span></Link>
  <Link className="dgw-guide-card" to="/docs/usage/device-guide"><strong>Explore the devices</strong><span>Generate mutations, optimize, morph and compare.</span></Link>
</div>

<figure>
  <a href={useBaseUrl('/img/devices/workspace.png')}><img src={useBaseUrl('/img/devices/workspace.png')} alt="DGW workspace with source and candidate tracks, devices, Track Monitor and the Evidence panel" /></a>
  <figcaption>DGW v0.1 with synthetic example data. Click the image for full resolution.</figcaption>
</figure>

## The workflow

![Import a sample, create alternative tracks, edit, evaluate, compare and save or export](/img/dgw-workstation-workflow.svg)

The source track keeps the imported calls. DGW also creates an editable **Working track**. Duplicate tracks whenever you want another alternative; each track contains both chromosome copies of the same sample.

The layout is inspired by music production software: tracks hold alternatives, devices provide tools, and edits remain reversible. You do not need musical experience. [See the DAW parallels](reference/faq.md#why-is-dgw-inspired-by-digital-audio-workstations).

## What would you like to do?

| Task | Start with |
| --- | --- |
| Change one allele manually | [Edit and compare](usage/edit-and-compare.md) |
| Work on a gene or thousands of variants | [Navigate and select](usage/focused-workspace.md) |
| Generate or search for alternative ALTs | [Device guide](usage/device-guide.md) |
| Understand a prediction or Monitor score | [Understand results](usage/evaluate-alleles.md) |
| Keep the experiment or use its output elsewhere | [Save and export](usage/render-state.md) |
| Automate DGW or modify its code | [Developers and advanced use](technical-details/index.md) |

:::note[Input and interpretation]
DGW accepts one diploid sample from a VCF, with SNVs and short indels. Supplied resources support GRCh37 and GRCh38. It evaluates alleles independently: a lower score does not establish restored function or a healthier genome. [Scope and limitations](about/disclaimer.md).
:::
