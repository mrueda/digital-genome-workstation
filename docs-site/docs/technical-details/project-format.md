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

`project.sqlite` stores indexed root-variant columns with compatibility payloads, immutable states and edits, named genome-track records, workspace state, a resumable workstation-session record, per-device cached evaluations, persistent background-job records, immutable device-run records, compound mutation layers, and warnings. The public schema version remains **1**. Opening an earlier schema-1 package performs idempotent additive migrations: it creates the source/working tracks, session and compute tables when needed, backfills indexed allele columns, and adds indexes without changing the manifest version or the frozen source artifact.

Each `background_jobs` payload records job and device identity, target track, execution status and progress, requested worker-thread limit, a device-owned request envelope, aggregate result or error, and timestamps. Mutation Generator jobs retain their staged layer ID. Track Profiler jobs retain per-device coverage, exact-match counts, the additive consequence-impact delta when complete, and a scientific-input fingerprint covering active allele-copy mutations, prediction/database devices, and resource identity. This permits safe reuse by an unchanged duplicate without treating track ID as scientific input. These rows preserve compute history and restore the Monitor result after reopening. They do not grant a device direct SQLite access; the host owns every write.

Each current track payload stores its name, base state, head state, visible bypassed edit IDs, read-only status, timestamps, archived status, and an internal `baselineBypassedEditIds` list when consolidation needs private baseline exclusions. Older track JSON remains readable because this private list defaults to empty.

The immutable state and edit tables remain the biological provenance layer; they are not replaced by mutable sequence blobs. Consolidation retains ancestry by moving the track base pointer rather than deleting those rows. Track rendering combines `baselineBypassedEditIds` with the current visible bypass list.

The singleton `workstation_session` record stores versioned JSON for the current focus, allele selection, selected device/view, hidden tracks, per-track applied-device order and bypass state, current built-in device controls/results, and interface Undo/Redo stacks. It is debounced during normal work and flushed by **Save Project** and before switching projects. A running device state reopens as ready rather than pretending an interrupted frontend task is still running. Machine-wide display preferences such as interface scale remain user settings rather than project state.

The resumable session and background-job rows are operational state. A separate write-once `device_runs` ledger records each terminal device invocation: device and version, input track/state fingerprint, selection, parameters, resource identity, result summary, generated edit or compound-layer IDs, status, timestamps, error, and stated limitation. Clearing finished jobs does not remove this ledger. Applying a bulk result creates a single history marker backed by indexed `compound_mutation_layers` and `compound_mutation_changes` rows. It is bypassed, undone, consolidated, projected, and exported atomically without sending every child change to the WebView. Large external scoring resources remain linked by fingerprint rather than copied into the package.

**Save a Copy** creates a consistent SQLite snapshot, copies package-owned artifacts and exports, assigns a new project ID, and records the immediate source project ID in `copiedFromProjectId`. The copied manifest keeps package files as relative paths, so the new `.dgw` directory remains portable. The command refuses to overwrite an existing destination or place a copy inside its source package.

Large-VCF access is bounded. Region, density, and page queries use the indexed allele columns instead of deserializing the full root set. The backend page size is 200 rows, track detail is limited to 500 marks per request, and broad navigation returns 256 density bins. Whole-track and interval selections are stored as compact selection descriptions with explicit exclusions and resolved by the backend only when a bounded device operation needs exact keys.

External Device API packages are not part of the project format because external installation/execution is not enabled. When that foundation exists, a project should pin device identity/version/API compatibility separately from the resource-pack identity and fingerprint. It should not copy executable packages or licensed database snapshots into every `.dgw` directory.

The original cohort VCF and large Evidence resources are linked, not copied. The frozen selected-sample artifact is a derived project input and is sufficient to reopen tracks and their history if the original file has moved. Ordinary biallelic source rows may retain raw imported INFO there, but multiallelic rows are frozen as exact-ALT GT-only projections because allele-indexed fields cannot be copied safely after decomposition. Operational rows ignore imported INFO in every case.

Exports are not part of the scientific state DAG. A clean VCF export is accompanied by `<output>.evidence.json.gz`, containing cached exact-allele results, and `<output>.device-runs.json.gz`, containing the immutable project run ledger. The provenance JSON links and hashes both. These project-wide sidecars may include evidence or runs that are not active in the exported track.
