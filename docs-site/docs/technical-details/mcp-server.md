# MCP: use DGW through an agent

**MCP (Model Context Protocol) lets an agent operate DGW through structured commands.** The agent can inspect a saved project, generate edits, evaluate a track and export the result.

DGW has two MCP modes. **Desktop access (v0.1.1)** connects an agent to the project open in the app. **Standalone access** uses `dgw-mcp` to work with saved projects without opening the desktop. Both use the existing MCP tools and `dgw-core`; the agent does not reproduce DGW's algorithms.

## Connect to the desktop

1. Open a project in DGW, then open **Settings → Agent access**.
2. Leave access read-only, or select **Allow edits, analysis and exports**.
3. Confirm sharing and choose **Enable access**.
4. In Codex Desktop's MCP configuration, choose **STDIO** and copy the command, arguments and environment values shown by DGW. Alternatively, use **Copy Codex configuration**.

The connector is part of the installed application. No Python, Rust or separate download is required. Keep DGW open. On macOS, move DGW to Applications before configuring the connection.

| Setting | Value |
| --- | --- |
| Command | The installed DGW executable shown in Settings |
| Arguments | `--mcp-connect` |
| Environment | `DGW_MCP_ADDRESS` and `DGW_MCP_TOKEN`, copied from Settings |
| Working directory | Leave empty |

The local address is an internal connection address, **not an HTTP or remote MCP URL**. Credentials expire after eight hours. Turning access off, switching projects or restarting DGW revokes them; enable access again and update the client settings. Already accepted jobs may finish after access is revoked.

:::note[What is shared]
Access covers the open project, not just its selected variants. `desktop_context` reports the active track, its current head, the selection and focused region. Selection changes appear on the next call; an empty selection never means “select all”. A connected cloud agent may send returned project data to its model provider. Keep tokens out of prompts and screenshots.
:::

Try: **“Describe the open DGW project and current selection. Do not change anything.”** With editing enabled, agent changes refresh the desktop tracks, and completed profiles are available to Track Monitor. Jobs appear in the existing Jobs panel. Explicit tool parameters and stale-track checks still apply.

Read-only connections expose inspection tools and manual-edit validation. Editing access exposes the original 22 tools plus `desktop_context`. The source track remains protected. Screen interaction is independent of MCP access: disabling MCP does not disable an agent's permission to use the screen.

Codex Desktop is the first target client. ChatGPT Work MCP compatibility has not been established; screen interaction remains a separate option.

## Standalone access and reproducibility

The standalone `dgw-mcp` executable, its 22 tools, saved seeds and explicit parameters remain available for scripts and the manuscript experiments. Desktop connection support does not change the scoring algorithms or require rerunning those experiments. Keep the software and resource versions recorded with each experiment.

<div className="dgw-flow" role="group" aria-label="An MCP client launches dgw-mcp over standard input and output; dgw-mcp calls dgw-core to operate a saved project">
  <div><strong>Agent / MCP client</strong><span>Requests an operation</span></div>
  <span className="dgw-flow-arrow" aria-hidden="true">→</span>
  <div><strong>dgw-mcp</strong><span>Structured tools over stdio</span></div>
  <span className="dgw-flow-arrow" aria-hidden="true">→</span>
  <div><strong>dgw-core</strong><span>Project, resources and calculations</span></div>
</div>

### Build the standalone server

First create and save a `.dgw` project in the desktop app. Its registered resource paths must be accessible to the account running the MCP server.

Build the server from the repository root using the Rust toolchain:

```bash
cargo build --release -p dgw-mcp
./target/release/dgw-mcp --version
```

Add a server entry to your MCP client's configuration. The client launches the executable and communicates over standard input/output; the standalone server does not open a network port.

```json
{
  "mcpServers": {
    "dgw": {
      "command": "/absolute/path/to/digital-genome-workstation/target/release/dgw-mcp"
    }
  }
}
```

On Windows, point to `dgw-mcp.exe`. Client configuration locations vary. Restart or reload your client after adding the entry; DGW currently exposes **22 tools**.

:::tip[The process appears to wait]
Running `dgw-mcp` alone in a terminal starts the protocol server, which waits for a client. Use `--help` or `--version` for a terminal check.
:::

## Try a read-only request

Ask your connected agent:

> Open /data/example.dgw, summarize the assembly and sample, list the tracks, find LDLR, and show the first 20 effective variants on the active track. Do not edit anything.

The agent uses `open_project`, `project_summary`, `list_tracks`, `search_genes` and `list_variants`. Results are structured project data, not screenshots.

Most tools accept an optional `project_path`; otherwise they use the last opened project. Genomic coordinates are **1-based**. Variant-page offsets are **0-based**, with at most 200 records per page.

## Make and evaluate changes

MCP keeps **preview and apply as separate commands**, even where the desktop presents one action button.

| Stage | Agent action | What changes |
| --- | --- | --- |
| Inspect | Read track ID, current `headStateId` and variant selection. | No allele changes. |
| Preview | Start a Generator, Optimizer or Morph preview; poll `get_job`. | A candidate result is saved; the track's alleles stay unchanged. |
| Apply | Inspect the completed result, then call its matching apply tool. | One reversible mutation layer is attached to the explicit track. |
| Evaluate | Start Track Profiler using the new head; poll `get_job`. | Predictions, coverage and the Monitor profile are saved. |
| Export | Start VCF export or request a regional FASTA. | New files are written at the requested destination. |

For example:

> Duplicate the source as “TTN randomized”. Select the imported TTN variants, preview Uniform randomization at 100% with seed 42, and show the counts. Apply the result to that duplicate, then profile the track and report coverage and the impact delta.

A single manual edit uses `preview_allele_edit` and `apply_allele_edit`. Copy the exact source allele and copy placement from the variant result; the preview returns normalized before/after states.

:::note[An old preview cannot overwrite a newer track]
Apply checks the captured track state and bypass choices. If the track changed, read its current state and make a fresh preview. Morph checks both participating tracks. The protected source is never an edit target.
:::

## Supported operations

| Tool | Purpose |
| --- | --- |
| `open_project` | Validate an existing `.dgw` directory and make it active for later calls. |
| `project_summary` | Report the project, assembly, sample, resource bundle, track count, contig count, and imported variant count. |
| `list_tracks` | Return the non-archived tracks and identify the active track. |
| `select_track` | Make an existing track active without changing its alleles or history. |
| `duplicate_track` | Create an editable copy of a track and make the copy active. |
| `rename_track` | Change a track's name without changing its allele state. |
| `list_variant_contigs` | Return the contigs, imported-variant counts, and one-based coordinate bounds. |
| `list_variants` | Return a bounded page of effective variants for one track. |
| `preview_allele_edit` | Normalize and validate one exact source-allele replacement or reference restore without writing it. |
| `apply_allele_edit` | Apply the unchanged preview if the explicit target track still has the expected head state. |
| `start_mutation_generator_preview` | Start a Randomizer preview for explicit alleles, an interval, an exact gene, or the whole track. |
| `apply_mutation_generator_preview` | Apply a completed Randomizer preview as one compact reversible mutation layer. |
| `start_genome_morph_preview` | Compare two explicit track states and preview copying a percentage of their whole-position differences. |
| `apply_genome_morph_preview` | Apply a completed morph preview as one compact reversible mutation layer on its source track. |
| `start_genome_optimizer_preview` | Start Saturation or Conservative optimization as a persistent, non-mutating preview. |
| `apply_genome_optimizer_preview` | Apply a completed optimizer preview as one compact reversible mutation layer. |
| `start_track_profiler` | Analyze active track mutations with Consequence Predictor and the requested database evidence devices. |
| `start_track_vcf_export` | Export an explicit track head as a new BGZF/CSI VCF and provenance sidecars. |
| `export_region_fasta` | Export up to 50 kb as reference, chromosome-copy A, and chromosome-copy B FASTA records. |
| `search_genes` | Search the project's assembly-matched gene index and count imported variants overlapping each result. |
| `list_jobs` | Return bounded summaries of recent persistent background jobs and their progress. |
| `get_job` | Return one complete persistent job, including its request and any result, by identifier. |

## Selection, jobs and results

| Operation | Scope and controls |
| --- | --- |
| Mutation Generator | Explicit alleles, an interval, an exact gene or the whole track; amount, seed and substitution pattern. |
| Genome Optimizer | The same selection forms; Saturation or Conservative mode, direction and maximum changes. |
| Genome Morph | Differences between two tracks in the same project; percentage and genomic or seeded-random order. |
| Track Profiler | Active mutations and a specified set of prediction/database devices. |
| VCF export | Explicit track head, all chromosomes. |
| FASTA export | Explicit track and reference interval, at most 50 kb. |

The MCP selection run limit defaults to 100,000 for Generator and Optimizer and fails explicitly when exceeded. This differs from the desktop Mutation Generator's default limit of 1,000. The 100,000 ceiling is an experimental safety limit, not a performance benchmark. A no-op preview is a valid completed result; applying it changes nothing.

Jobs run away from protocol handling, through one local compute slot in this MCP process. Poll `get_job` for progress and the result. Optional `worker_threads` is bounded to 1–256 and defaults to available processors minus one. Supported engines use the same bounded parallel coordinator as the desktop.

Track Profiler saves the profile used by Track Monitor; applying an MCP mutation alone does not perform that profiling step. In standalone mode, reopen the project in the desktop to inspect saved tracks and results. In desktop-connected mode, the open workspace refreshes after agent operations and job completion. Avoid simultaneous edits to the same track from two interfaces; state checks reject stale requests.

<details>
<summary>Evidence, scoring and export details</summary>

Saturation uses live independent-allele consequence predictions and the fixed ClinVar Pathogenic/Likely pathogenic guard. Conservative optimizes ALT-copy distance from reference. These are the same [scoring models](scoring-methods.md) used by the desktop.

For profiling, omit `device_ids` to request Consequence Predictor, ClinVar and COSMIC, or provide a non-empty subset. Results capture the resource identities and report unavailable resources explicitly.

VCF export is a background job; FASTA export is synchronous and bounded to 50 kb. Exports reject existing destinations and paths inside the project package. Results identify the generated files and sidecars. [Export contents](../usage/render-state.md).

</details>

## Current limits

MCP cannot create projects, consolidate or archive tracks, or delete project data. Use the desktop for those actions. It does not expose Track Compare's views or the selection-based Consequence Predictor report.

The standalone server runs with its operating-system account's file permissions. It is a local command interface, not a sandbox. Desktop mode accepts authenticated loopback connections and restricts tools to the shared project. Editing access also permits exports to new destinations outside that project. If you use a cloud-hosted agent, the project information returned to that client may be sent to its model provider.

Opening a project performs the same compatible schema maintenance as the desktop. Changes pass through core validation and persistence; the MCP adapter does not independently edit SQLite. See [Architecture](architecture.md) and [Project format](project-format.md).
