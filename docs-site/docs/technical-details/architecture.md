# Architecture

## Local data flow

```text
VCF + selected sample
                  │
                  ▼
     normalize private project copy
                  │
                  ▼
       read-only source genome track
                  │
             duplicate
                  │
                  ▼
         experimental genome track
                  │
      device rack + execution strategy
                  │
       ┌──────────┼──────────────┬──────────────────┐
       ▼          ▼              ▼                  ▼
 focused DNA  interactive       background       live exact-allele
              edit blocks       aggregate job       evidence
```

The desktop app has no network server, account, telemetry, or remote patient-data path. An optional local MCP process gives agents a command interface over standard input/output; it calls `dgw-core` directly and does not create a network endpoint or automate the React interface. Biological resources remain outside the project and are registered by local path. Imported VCF INFO annotations are accepted but ignored by the operational model; every displayed consequence or database result comes through the live exact-allele evidence boundary.

One track is one complete diploid scenario for the selected sample within the input data. Homologous chromosome copies A and B are reconstructed inside that track; A/B identifies phased VCF slots, not parental origin. A track must never be used as a synonym for one haplotype.

The track-and-device workspace is the primary implemented interface. The read-only source track is duplicated into independent experimental tracks. Manual and optimizer changes become persistent edit blocks; selecting or bypassing a block changes the effective preview without modifying the source.

## User model and provenance model

The user works with named tracks, devices, and edit blocks. The engine continues to use an immutable edit-state DAG:

```text
named track ──► base state + head state
                   + visible bypass mask
                   + private baseline exclusions
                              │
                              ▼
                 immutable state/edit ancestry
```

Duplicating a track initially creates another pointer to the same head. Its first change creates a new DAG branch. History checkout and A/B state identifiers are therefore implementation capabilities, not primary workspace areas.

More precisely, the implemented ancestry is a tree-shaped DAG rather than an arbitrary merge graph. Each immutable state row has at most one `parentId` and one creating edit. Multiple named tracks can reference the same state and therefore share ancestry without copying complete genome materializations:

```text
                     edit B ──► state B ──► track 1
source ──► state A ──┤
                     edit C ──► state C ──► track 2
```

There are no backward edges and no two-parent state merges. A cross-track operation such as Genome Morph computes differences and records the accepted result as a new child edit on the destination track. A compact bulk layer is likewise one ancestry edit whose normalized child changes live in indexed tables.

This graph is DGW's provenance architecture, not a claim about proprietary DAW internals. DAW documentation supports the behavioural analogy—non-destructive clips, shared project or track alternatives, comp rows, bypass, and explicit bounce/consolidation—but does not expose an equivalent storage graph. The manuscript and documentation must keep the inspiration and the implementation claim separate.

Deleting an experimental track archives the workspace object. Its immutable state/edit ancestry remains available to other references and the audit model.

Consolidation sets `baseStateId = headStateId`, so `edits_for_track` returns no pre-baseline blocks. Before clearing the visible bypass mask, the engine copies bypassed ancestry IDs into a private `baselineBypassedEditIds` field in the stored track payload. Effective sequence reconstruction and track rendering use the union of private baseline exclusions and visible post-baseline bypasses. The visual lane is flattened without changing the effective alleles.

## Device boundary

The Device Browser has four user-facing functional groups. Mutation Generator belongs to Edit; Variant Consequences, ClinVar, and COSMIC belong to Evidence; objective-driven track models such as Genome Optimizer belong to Analyze; and Variant Map belongs to Visualize. A track's Rack contains only applied instances in order, while Genome Optimizer still returns reviewable edit proposals through the host protocol. Device code is distinct from the reference/model/database resource packs it consumes.

The compatibility boundary is a versioned, structured DGW Device API. “VST-like” describes the rack interaction only; it is not an audio plug-in ABI. A device receives host-prepared genomic input and returns structured proposals or results. It never receives authority to mutate project SQLite or files directly. The host validates proposed edits, owns caching and persistence, and records accepted results.

The built-in Genome Optimizer follows this shape: its core planner is non-mutating, and the Tauri host applies accepted proposals through normal track APIs. Variant Consequences and the database adapters return structured records through the evaluation boundary. The core validates versioned manifests and protocol messages, and the UI obtains its rack catalog from that core contract. External installation, isolation, and third-party execution are not enabled yet. See [Device API and Resource Packs](device-api.md).

One device may use two host execution strategies without appearing twice in the Rack. Small editing selections may produce individually visible immutable blocks, while larger selections use a persistent background job and compact compound layer attached to the same device and track. Background previews return aggregate counts rather than transferring or rendering every change. Track Profiler uses one persistent background strategy for both ordinary blocks and compound layers: exact source/current alleles are deduplicated, Variant Consequences evaluates each batch through the configured bcftools/Ensembl resources, and each indexed database is queried in bulk. Its scientific-input fingerprint excludes track identity, so an unchanged duplicate can reuse a compatible result. Jobs are queued through a shared compute slot, report progress, can be cancelled between stages, and remain listed in the project Jobs view. The user-configurable worker-thread value is recorded with each job and is applied by engines that support parallel workers.

The implemented **Genome Optimizer** remains experimental. It accepts a mode, focused interval, selected variants where required, an objective, a direction, weights, active evidence-device IDs, and a maximum edit count:

- Conservative **Distance from reference (ALT copies)** assigns `1` per selected active alternate-allele copy and uses no evidence input;
- minimize emits `RestoreReference` only for active alleles that exactly occur in the immutable source; and
- maximize emits `SetAllele` only to reintroduce an exact original-source allele absent from the current track and only when its additive score delta is positive.
- saturation enumerates the three non-REF bases at each selected canonical SNV, obtains host-evaluated evidence, requires a comparable predicted impact for every candidate, and emits `SetAllele` for the winning ALT.

Conservative does not read predicted consequences, ClinVar, imported INFO, or another Evidence-device output. Saturation uses live `bcftools csq` impact to rank complete three-ALT comparisons. ClinVar provides a fixed Pathogenic/Likely pathogenic candidate guard rather than a score fader. COSMIC and any future unlisted device are evidence-only unless a later model explicitly names their outputs.

Candidates are sorted by score improvement and stable allele/copy tie breakers. Conservative mode truncates copy-level proposals to `maxEdits`; Saturation interprets the same protocol bound as a position-group limit and emits every active copy operation for each accepted position. Unsafe overlaps, ambiguous source replacements, and zero-benefit choices become explicit exclusions. Accepted proposals pass through the normal track edit validator and become ordinary visible edit blocks.

No device API may imply continuous allele mixing. Controls change model parameters, but device output remains discrete normalized alleles. The current score is explicitly additive and does not model nearby interactions, phase-dependent compound effects, penetrance, or the rest of the genome. REF measures a candidate's distance from the registered reference; it does not mean healthy, safe, ancestral, common, or benign.

## Session persistence and reproducibility boundary

Track records, edit operations, per-edit bypass state, consolidation baseline, private baseline exclusions, background jobs, and compact mutation layers persist as structured SQLite records. A separate versioned workstation-session record restores focus, selection, track/device presentation, applied-device order and bypass state, built-in device controls/results, and interface Undo/Redo stacks. This makes reopening a project operationally continuous without mixing mutable interface state into the immutable biological edit graph.

The workstation session is not a substitute for scientific provenance. Interactive edits retain validated operations and a short note. Completed, failed, and cancelled device invocations also enter a write-once run ledger with their declared selection and parameters, input fingerprint, resource identity, aggregate result, output edit or layer IDs, status, and limitation. Bulk records omit candidate-by-candidate rows and intermediate evaluation payloads, so reproducing those details requires rerunning the recorded request with the pinned resources.

## Engine boundary

The Rust `dgw-core` crate has no Tauri or MCP dependency. This allows state, VCF, sequence, and evaluation behavior to be tested in headless environments. The desktop crate converts Tauri commands into core calls and retains the persistent evaluation service for the application lifetime. The separate `dgw-mcp` crate converts MCP tools into the same core calls; scientific and project semantics do not live in either transport adapter.

SQLite uses WAL mode and foreign keys. Root variants have indexed allele/region columns plus compatibility payloads, allowing page, region, density, and exact-locus queries without loading the complete VCF. The public project schema remains version 1; additive indexes and backfills are an idempotent schema-1 migration.

The application boundary is bounded: source variants are paged 200 at a time, a detailed track request returns at most 500 marks, and broad regions use 256 density bins. Interval and whole-track selections stay symbolic until the backend resolves them for a device. Genome Optimizer routes selections above 100 positions to a background evidence-and-reduction job; Mutation Generator routes selections above the configurable interactive threshold to a background aggregate preview. Both have user-configurable run limits and a 100,000-position experimental ceiling. Bulk Apply creates one state node and keeps its allele changes in an indexed normalized table, so focused projections and exports remain exact without rendering thousands of blocks.

## Reference access

hs37d5 is BGZF-compressed. DGW calculates uncompressed byte offsets from the FAI line geometry and asks bgzip for only the focused range using the GZI index. It then materializes each genome copy of the selected track by applying active variants in reverse coordinate order.

## Failure behavior

Projects can reopen from their frozen root artifact when the original VCF moves. The reference and VCF tool core is required, while the Ensembl consequence annotation, ClinVar, and COSMIC resources are optional device inputs. A missing optional resource makes only that device—or an optimizer mode that explicitly requires it—unavailable. Worker errors, resource unavailability, predicted no-feature results, and database no-match results remain separate states.

VCF export contains effective alleles, genotypes, and DGW provenance rather than imported or live consequence annotations. Cached live evidence is written to a compressed JSON sidecar and linked by the provenance sidecar.
