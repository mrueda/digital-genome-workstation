# Agent Access (MCP)

DGW includes a local Model Context Protocol server so an agent can operate on DGW projects through commands instead of clicking the interface. The server is a separate executable called `dgw-mcp`. It calls `dgw-core` directly; it does not drive the desktop interface and does not expose an HTTP service.

The first implementation is deliberately read-only at the command level. It can inspect an existing project but cannot create, rename, duplicate, edit, consolidate, export, or delete anything. Opening a project still uses DGW's normal `Project::open` path, which may perform the same idempotent schema maintenance used by the desktop when an older compatible package is opened; it does not create a genome edit.

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

Restart or reload the client after adding the entry. The client should report a server named `dgw-mcp` with eight tools.

## Available tools

| Tool | Purpose |
| --- | --- |
| `open_project` | Validate an existing `.dgw` directory and make it active for later calls. |
| `project_summary` | Report the project, assembly, sample, resource bundle, track count, contig count, and imported variant count. |
| `list_tracks` | Return the non-archived tracks and identify the active track. |
| `list_variant_contigs` | Return the contigs, imported-variant counts, and one-based coordinate bounds. |
| `list_variants` | Return a bounded page of effective variants for one track. |
| `search_genes` | Search the project's assembly-matched gene index and count imported variants overlapping each result. |
| `list_jobs` | Return bounded summaries of recent persistent background jobs and their progress. |
| `get_job` | Return one complete persistent job, including its request and any result, by identifier. |

Most calls accept an optional `project_path`. If it is omitted, the server uses the project most recently opened with `open_project`. `list_variants` returns at most 200 records per call and uses a zero-based result offset; genomic positions remain one-based VCF coordinates.

For example, an agent can be asked:

> Open `/data/example.dgw`, summarize it, find LDLR, list its tracks, and show the first 20 effective variants on the active track.

The agent receives structured JSON derived from the project SQLite state. It does not need to infer state from screenshots or reproduce DGW's algorithms.

## Boundary

`dgw-mcp` is a transport adapter. Project opening, gene coordinate translation, track access, variant paging, and job persistence remain in `dgw-core`. The MCP crate defines tool schemas, maintains the active-project choice for the current process, runs blocking SQLite work away from the protocol executor, and formats bounded structured responses.

Tool execution errors are returned as MCP tool errors so an agent can correct a path or identifier. A failed operation does not silently return an empty result. The process can access only files allowed by the operating-system account that launched it.

Genome-changing commands will be added only after their input contracts, preview behavior, track targeting, and provenance expectations are explicit. The eventual command path must call the same validated operations used by the desktop host; MCP will not receive direct write access to project SQLite files.
