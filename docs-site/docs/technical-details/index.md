# Developers and advanced use

Use this section to run DGW from source, automate projects with MCP, or inspect the calculations and file formats.

import Link from '@docusaurus/Link';

<div className="dgw-guide-grid">
  <Link className="dgw-guide-card" to="/docs/technical-details/developer-guide"><strong>Build DGW</strong><span>Source setup, repository layout and checks.</span></Link>
  <Link className="dgw-guide-card" to="/docs/technical-details/mcp-server"><strong>Use MCP</strong><span>Connect an agent to real DGW project operations.</span></Link>
  <Link className="dgw-guide-card" to="/docs/technical-details/scoring-methods"><strong>Inspect the methods</strong><span>Formulas, evidence rules and score limitations.</span></Link>
</div>

## One core, two interfaces

<div className="dgw-flow" role="group" aria-label="The desktop and MCP interfaces call dgw-core, which owns projects and evaluation">
  <div><strong>Desktop</strong><span>React + Tauri</span></div>
  <span className="dgw-flow-arrow" aria-hidden="true">→</span>
  <div><strong>dgw-core</strong><span>Tracks, edits, jobs, evaluation and export</span></div>
  <span className="dgw-flow-arrow" aria-hidden="true">←</span>
  <div><strong>MCP client</strong><span>Agent → dgw-mcp over stdio</span></div>
</div>

Both interfaces call the same Rust engine. The core owns project writes and invokes the configured prediction tools and indexed databases. [Architecture](architecture.md).

| Question | Reference |
| --- | --- |
| How do tracks share edit history? | [State model](state-model.md) |
| What can a device do? | [Device API](device-api.md) |
| How are predictions queried and cached? | [Evaluation engine](evaluation-engine.md) |
| What are the import and export guarantees? | [VCF contract](vcf-contract.md) |
| What is inside a saved project? | [Project format](project-format.md) |
| How do I configure custom data paths? | [Resource bundle](resource-bundle.md) |
| What has been checked? | [Tests](testing.md), [installer validation](../usage/test-installation.md), [performance](../reference/performance.md) |

For normal installation and day-to-day workflows, use the [User guide](../overview.md).
