# Architecture

## Local data flow

```text
normalized VCF + selected sample
                  │
                  ▼
       read-only source genome track
                  │
             duplicate
                  │
                  ▼
         experimental genome track
                  │
        device rack + visible edit blocks
                  │
       ┌──────────┼──────────────┐
       ▼          ▼              ▼
 focused DNA   live exact-allele   optional consolidation
                  evidence        or clean VCF export
```

The app has no server, account, telemetry, or remote patient-data path. Biological resources remain outside the project and are registered by local path. Imported VCF INFO annotations are accepted but ignored by the operational model; every displayed consequence or database result comes through the live exact-allele evidence boundary.

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

Deleting an experimental track archives the workspace object. Its immutable state/edit ancestry remains available to other references and the audit model.

Consolidation sets `baseStateId = headStateId`, so `edits_for_track` returns no pre-baseline blocks. Before clearing the visible bypass mask, the engine copies bypassed ancestry IDs into a private `baselineBypassedEditIds` field in the stored track payload. Effective sequence reconstruction and track rendering use the union of private baseline exclusions and visible post-baseline bypasses. The visual lane is flattened without changing the effective alleles.

## Device boundary

The Device Browser has three user-facing functional groups. Mutation Generator belongs to Edit; SnpEff, dbNSFP, ClinVar, and COSMIC belong to Evidence; and objective-driven track models such as Genome Optimizer belong to Analyze. A track's Rack contains only applied instances in order, while Genome Optimizer still returns reviewable edit proposals through the host protocol. Device code is distinct from the reference/model/database resource packs it consumes.

The compatibility boundary is a versioned, structured DGW Device API. “VST-like” describes the rack interaction only; it is not an audio plug-in ABI. A device receives host-prepared genomic input and returns structured proposals or results. It never receives authority to mutate project SQLite or files directly. The host validates proposed edits, owns caching and persistence, and records accepted results.

The built-in Genome Optimizer follows this shape: its core planner is non-mutating, and the Tauri host applies accepted proposals through normal track APIs. SnpEff and the evidence adapters return structured records through the evaluation boundary. The core validates versioned manifests and protocol messages, and the UI obtains its rack catalog from that core contract. External installation, isolation, and third-party execution are not enabled yet. See [Device API and Resource Packs](device-api.md).

The implemented **Genome Optimizer** remains experimental. It accepts a mode, focused interval, selected variants where required, an objective, a direction, weights, active evidence-device IDs, and a maximum edit count:

- Conservative **Distance from reference (ALT copies)** assigns `1` per selected active alternate-allele copy and uses no evidence input;
- minimize emits `RestoreReference` only for active alleles that exactly occur in the immutable source; and
- maximize emits `SetAllele` only to reintroduce an exact original-source allele absent from the current track and only when its additive score delta is positive.
- saturation enumerates the three non-REF bases at each selected canonical SNV, obtains host-evaluated evidence, requires a comparable SnpEff impact for every candidate, and emits `SetAllele` for the winning ALT.

Conservative does not read SnpEff, ClinVar, imported INFO, or another Evidence-device output. Saturation uses live SnpEff impact to rank complete three-ALT comparisons. ClinVar provides a fixed Pathogenic/Likely pathogenic candidate guard rather than a score fader. dbNSFP, COSMIC, and any future unlisted device are evidence-only unless a later model explicitly names their outputs.

Candidates are sorted by score improvement and stable allele/copy tie breakers. Conservative mode truncates copy-level proposals to `maxEdits`; Saturation interprets the same protocol bound as a position-group limit and emits every active copy operation for each accepted position. Unsafe overlaps, ambiguous source replacements, and zero-benefit choices become explicit exclusions. Accepted proposals pass through the normal track edit validator and become ordinary visible edit blocks.

No device API may imply continuous allele mixing. Controls change model parameters, but device output remains discrete normalized alleles. The current score is explicitly additive and does not model nearby interactions, phase-dependent compound effects, penetrance, or the rest of the genome. REF measures a candidate's distance from the registered reference; it does not mean healthy, safe, ancestral, common, or benign.

## Current device-persistence limit

Track records, edit operations, per-edit bypass state, consolidation baseline, and private baseline exclusions persist in SQLite. The React layer currently owns device control settings, generated-edit grouping, status, and displayed run results. The Tauri command applies optimizer proposals as edits with a short direction/objective note, but it does not persist the full request, score components, exclusions, or plan. Reopening a project preserves the resulting genome but not enough data to reproduce an optimizer run exactly.

## Engine boundary

The Rust `dgw-core` crate has no Tauri dependency. This allows state, VCF, sequence, and evaluation behavior to be tested in headless environments. The desktop crate converts Tauri commands into core calls and retains the persistent evaluation service for the application lifetime.

SQLite uses WAL mode and foreign keys. Root variants have indexed allele/region columns plus compatibility payloads, allowing page, region, density, and exact-locus queries without loading the complete VCF. The public project schema remains version 1; additive indexes and backfills are an idempotent schema-1 migration.

The application boundary is bounded: source variants are paged 200 at a time, a detailed track request returns at most 500 marks, and broad regions use 256 density bins. Interval and whole-track selections stay symbolic until the backend resolves them for a device. Genome Optimizer is capped at 100 positions and Mutation Generator at 1,000; an over-limit request fails rather than being silently truncated.

## Reference access

hs37d5 is BGZF-compressed. DGW calculates uncompressed byte offsets from the FAI line geometry and asks bgzip for only the focused range using the GZI index. It then materializes each genome copy of the selected track by applying active variants in reverse coordinate order.

## Failure behavior

Projects can reopen from their frozen root artifact when the original VCF moves. The reference and VCF tool core is required, while SnpEff, dbNSFP, ClinVar, and COSMIC resources are optional device inputs. A missing optional resource makes only that device—or an optimizer mode that explicitly requires it—unavailable. Worker errors, resource unavailability, and no-match results remain separate states.

VCF export contains effective alleles, genotypes, and DGW provenance rather than imported or live consequence annotations. Cached live evidence is written to a compressed JSON sidecar and linked by the provenance sidecar.
