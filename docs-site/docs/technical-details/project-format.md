# Project Format

A `.dgw` project is a directory package:

```text
example.dgw/
├── manifest.json
├── project.sqlite
├── artifacts/
│   ├── root.selected.vcf.gz
│   └── root.selected.vcf.gz.csi
└── exports/
```

`manifest.json` identifies the project, selected sample, source VCF fingerprint, assembly, root state, resource bundle, and frozen selected-sample artifact.

`project.sqlite` stores indexed root-variant columns with compatibility payloads, immutable states and edits, named genome-track records, workspace state, per-device cached evaluations, persistent background-job records, compound mutation layers, and warnings. The public schema version remains **1**. Opening an earlier schema-1 package performs idempotent additive migrations: it creates the source/working tracks and compute tables when needed, backfills indexed allele columns, and adds indexes without changing the manifest version or the frozen source artifact.

Each `background_jobs` payload records job and device identity, target track, execution status and progress, requested worker-thread limit, a device-owned request envelope, aggregate result or error, and timestamps. Mutation Generator jobs retain their staged layer ID. Track Profiler jobs retain per-device coverage, exact-match counts, the additive SnpEff impact delta when complete, and the exact track state they describe. These rows preserve compute history and restore the Monitor result after reopening. They do not grant a device direct SQLite access; the host owns every write.

Each current track payload stores its name, base state, head state, visible bypassed edit IDs, read-only status, timestamps, archived status, and an internal `baselineBypassedEditIds` list when consolidation needs private baseline exclusions. Older track JSON remains readable because this private list defaults to empty.

The immutable state and edit tables remain the biological provenance layer; they are not replaced by mutable sequence blobs. Consolidation retains ancestry by moving the track base pointer rather than deleting those rows. Track rendering combines `baselineBypassedEditIds` with the current visible bypass list.

Applied device chains, device configurations and bypass state, generated-edit ownership, and formal optimizer-run records are not yet stored. Background Mutation Generator previews persist their request envelope, aggregate result, progress, compute limit, and complete normalized proposal set. Applying one creates a single history marker backed by indexed `compound_mutation_layers` and `compound_mutation_changes` rows. It is bypassed, undone, consolidated, projected, and exported atomically without sending every child change to the WebView. Interactive generated proposals persist as ordinary edit operations with a short objective/direction note. A future extension must store chain/order, scoring contract/version, components, exclusions, input identity, and uncertainty. Large external scoring resources remain linked by fingerprint rather than copied into the package.

Large-VCF access is bounded. Region, density, and page queries use the indexed allele columns instead of deserializing the full root set. The backend page size is 200 rows, track detail is limited to 500 marks per request, and broad navigation returns 256 density bins. Whole-track and interval selections are stored as compact selection descriptions with explicit exclusions and resolved by the backend only when a bounded device operation needs exact keys.

External Device API packages are not part of the project format because external installation/execution is not enabled. When that foundation exists, a project should pin device identity/version/API compatibility separately from the resource-pack identity and fingerprint. It should not copy executable packages or licensed database snapshots into every `.dgw` directory.

The original cohort VCF and large Evidence resources are linked, not copied. The frozen selected-sample artifact is a derived project input and is sufficient to reopen tracks and their history if the original file has moved. Ordinary biallelic source rows may retain raw imported INFO there, but multiallelic rows are frozen as exact-ALT GT-only projections because allele-indexed fields cannot be copied safely after decomposition. Operational rows ignore imported INFO in every case.

Exports are not part of the scientific state DAG. A clean VCF export may be accompanied by `<output>.evidence.json.gz`, containing the project's cached exact-allele device results and resource identities, plus the existing provenance JSON that links and hashes the evidence file. The v1 sidecar is a project-cache snapshot, not a claim that every entry is active in the exported track.
