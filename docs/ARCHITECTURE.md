# Architecture

## Data flow

DGW links the immutable source VCF by path and SHA-256, then freezes only the selected sample’s non-reference calls into the project package. The selected projection is validated by bcftools, BGZF-compressed, and CSI-indexed. SQLite stores root variants, immutable states, edit operations, workspace pointers, warnings, and cached evaluations.

All edits use b37 reference coordinates. A `GenomeState` has one parent and at most one `EditOperation`; editing an older state creates another child. Undo/redo is state checkout, bypass is a persisted mask over an ancestry path, and A/B slots hold state identifiers. No operation mutates or deletes the source calls.

```text
source VCF + selected sample
            │
            ▼
  frozen root state ── edit ── state B ── edit ── state C
            │
            └────────── edit ── state D

current state + bypass mask → effective phased alleles → focus/evaluate/render
```

Overlapping active edits on one haplotype are rejected unless an operation explicitly replaces its source allele. Distinct alleles on different haplotypes can share a locus and render as separate biallelic records.

## Evaluation

The normalized key `(assembly, contig, position, REF, ALT)` is the evaluation unit. A single serialized SnpEff process remains open across requests; VCF IDs correlate request and response records. ClinVar, and COSMIC are queried independently by exact normalized allele through tabix. Cache identities include the variant key and resource-bundle fingerprint. Errors and unavailable resources are not cached.

Imported `ANN` and INFO values remain frozen source evidence. Live evaluation is labelled separately. New and edited alleles never inherit measurements such as DP or AD from their source allele.

## Project package

```text
example.dgw/
├── manifest.json
├── project.sqlite
├── artifacts/
│   ├── root.selected.vcf.gz
│   └── root.selected.vcf.gz.csi
└── exports/
```

Rendered states contain phased GT, essential `DGW_*` fields, state/resource identifiers, and the checksum of a sibling `.provenance.json` containing the full lineage and resource manifest.

## Desktop boundary

`dgw-core` owns biological and persistence behavior and has no Tauri dependency. `dgw-desktop` exposes narrow commands for resource validation, import, state manipulation, focus, evaluation, and rendering. React owns only display and transient interaction state. This keeps the scientific engine testable without a GUI runtime and leaves room for a future CLI using exactly the same contracts.

