# Agent Access (MCP)

DGW includes a local Model Context Protocol server so an agent can operate on DGW projects through commands instead of clicking the interface. The server is a separate executable called `dgw-mcp`. It calls `dgw-core` directly; it does not drive the desktop interface and does not expose an HTTP service.

The server exposes bounded inspection plus a small set of controlled project changes. It can select, duplicate, and rename tracks, and it can preview and apply one manual allele edit at a time. Mutation Generator Randomizer mode is the first device workflow. It runs previews as persistent background jobs and applies a completed result as one reversible mutation layer. The server cannot create projects, run other devices, consolidate, export, archive tracks, or delete anything. Opening a project uses DGW's normal `Project::open` path, including the same idempotent schema maintenance used by the desktop for older compatible packages.

## Build the server

From the repository root:

```bash
cargo build --release -p dgw-mcp
./target/release/dgw-mcp --version
```

The release executable is self-contained apart from the operating-system and project/resource permissions already required by DGW. Do not run it directly without `--help` or `--version`: in normal use it waits for an MCP client on standard input.

## Connect an MCP client

MCP clients differ in where they store server configuration, but the server entry has this shape:

```json
{
  "mcpServers": {
    "dgw": {
      "command": "/absolute/path/to/digital-genome-workstation/target/release/dgw-mcp"
    }
  }
}
```

Restart or reload the client after adding the entry. The client should report a server named `dgw-mcp` with 15 tools.

## Available tools

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
| `search_genes` | Search the project's assembly-matched gene index and count imported variants overlapping each result. |
| `list_jobs` | Return bounded summaries of recent persistent background jobs and their progress. |
| `get_job` | Return one complete persistent job, including its request and any result, by identifier. |

Most calls accept an optional `project_path`. If it is omitted, the server uses the project most recently opened with `open_project`. `list_variants` returns at most 200 records per call and uses a zero-based result offset; genomic positions remain one-based VCF coordinates.

For example, an agent can be asked:

> Open `/data/example.dgw`, summarize it, find LDLR, list its tracks, and show the first 20 effective variants on the active track.

The agent receives structured JSON derived from the project SQLite state. It does not need to infer state from screenshots or reproduce DGW's algorithms.

For an allele edit, first call `list_tracks` and `list_variants`. Use an editable track's exact `id` and `headStateId`, and copy the complete source allele plus its chromosome-copy placement from the variant result. Call `preview_allele_edit`; inspect its normalized edit and `effectiveBefore`/`effectiveAfter` values; then pass the same request and returned `previewId` to `apply_allele_edit`. If the track changed between those calls, DGW rejects the apply and asks for a new preview. The read-only source track is never an edit target.

For Mutation Generator, call `start_mutation_generator_preview` with the editable track ID, its current `headStateId`, Amount, Seed, substitution pattern, and one selection. Gene selection requires an exact symbol or stable identifier; interval coordinates are one-based and inclusive. Whole-track and interval selections remain compact in the request. `max_positions` defaults to 100,000 and fails explicitly instead of truncating a larger selection. Poll `get_job` until it reports `completed`, inspect the aggregate result, and pass that job and captured head to `apply_mutation_generator_preview`. Preview may persist a candidate layer, but it does not move the track head. Apply moves the head once and returns the active mutation count. A no-op preview has no layer and returns `applied: false`.

The MCP process executes Mutation Generator work away from protocol handling and serializes its own device jobs through one local compute slot. Jobs and terminal device-run provenance are saved in the project, so the desktop Jobs view can inspect them. Applying through MCP does not yet start Track Profiler automatically; the returned mutation count is immediate, while evidence-based Track Monitor values require analysis from the desktop until Track Profiler receives its own command contract.

## Boundary

`dgw-mcp` is a transport adapter. Project opening, gene coordinate translation, track access, variant paging, job persistence, track changes, allele normalization, validation, preview projection, and edit persistence remain in `dgw-core`. The MCP crate defines tool schemas, maintains the active-project choice for the current process, runs blocking SQLite work away from the protocol executor, and formats bounded structured responses.

Tool execution errors are returned as MCP tool errors so an agent can correct a path or identifier. A failed operation does not silently return an empty result. The process can access only files allowed by the operating-system account that launched it.

Preview identifiers bind a manual edit to the project, track, head state, bypass state, chromosome copy, and normalized allele change. Mutation Generator jobs capture the track head in their persistent request, and their staged layer retains that source state. Apply operations use conditional track and layer updates, so another writer cannot silently move the head after validation. Resulting states and edits use the same immutable DAG and source-track protection as desktop edits. MCP has no direct write access to project SQLite files.
