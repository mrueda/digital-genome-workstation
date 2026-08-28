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

`project.sqlite` stores root-variant JSON, immutable states and edits, named genome-track records, workspace state, cached evaluations, and persistent warnings. The current schema version is 1. Opening an older schema-1 project performs an idempotent migration that creates a read-only source track and an editable working track from the existing workspace pointers.

Each current track payload stores its name, base state, head state, visible bypassed edit IDs, read-only status, timestamps, archived status, and an internal `baselineBypassedEditIds` list when consolidation needs private baseline exclusions. Older track JSON remains readable because this private list defaults to empty.

The immutable state and edit tables remain the biological provenance layer; they are not replaced by mutable sequence blobs. Consolidation retains ancestry by moving the track base pointer rather than deleting those rows. Track rendering combines `baselineBypassedEditIds` with the current visible bypass list.

Device configurations, generated-edit ownership, displayed optimizer results, and formal optimizer-run records are not yet stored. Generated proposals persist only as ordinary edit operations with a short objective/direction note. A future schema extension must store the full request, scoring contract/version, components, exclusions, input identity, generated edit IDs, and uncertainty. Large external scoring resources remain linked by fingerprint rather than copied into the package.

External Device API packages are not part of the project format because external installation/execution is not enabled. When that foundation exists, a project should pin device identity/version/API compatibility separately from the resource-pack identity and fingerprint. It should not copy executable packages or licensed database snapshots into every `.dgw` directory.

The original cohort VCF and large annotation resources are linked, not copied. The frozen selected-sample artifact is a derived project input and is sufficient to reopen tracks and their history if the original file has moved.
