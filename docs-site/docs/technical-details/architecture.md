# Architecture

## Local data flow

```text
external annotated VCF + selected sample
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
 focused DNA   per-allele     optional consolidation
               evaluation       or VCF export
```

The app has no server, account, telemetry, or remote patient-data path. Biological resources remain outside the project and are registered by local path.

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

The rack has three device roles. Genome Optimizer is an editing device, SnpEff is an analysis device, and dbNSFP/ClinVar/COSMIC are evidence devices. Device code is distinct from the reference/model/database resource packs it consumes.

The compatibility boundary is a versioned, structured DGW Device API. “VST-like” describes the rack interaction only; it is not an audio plug-in ABI. A device receives host-prepared genomic input and returns structured proposals or results. It never receives authority to mutate project SQLite or files directly. The host validates proposed edits, owns caching and persistence, and records accepted results.

The built-in Genome Optimizer follows this shape: its core planner is non-mutating, and the Tauri host applies accepted proposals through normal track APIs. SnpEff and the evidence adapters return structured records through the evaluation boundary. The core validates versioned manifests and protocol messages, and the UI obtains its rack catalog from that core contract. External installation, isolation, and third-party execution are not enabled yet. See [Device API and Resource Packs](device-api.md).

The implemented **Genome Optimizer** remains experimental. It accepts the focused interval, one of two objectives, a direction, three weights, and a maximum edit count:

- alternate-allele burden assigns `1` per active alternate-allele copy;
- predicted-impact burden adds weighted normalized impact, recognized ClinVar classification, and exact-source-membership signals per allele copy;
- minimize emits `RestoreReference` only for active alleles that exactly occur in the immutable source; and
- maximize emits `SetAllele` only to reintroduce an exact original-source allele absent from the current track and only when its additive score delta is positive.

Candidates are sorted by score improvement and stable allele/copy tie breakers, then truncated to `maxEdits`. Unsafe overlaps, ambiguous source replacements, and zero-benefit choices become explicit exclusions. Accepted proposals pass through the normal track edit validator and become ordinary visible edit blocks.

No device API may imply continuous allele mixing. Controls change model parameters, but device output remains discrete normalized alleles. The current score is explicitly additive and does not model nearby interactions, phase-dependent compound effects, penetrance, or the rest of the genome.

## Current device-persistence limit

Track records, edit operations, per-edit bypass state, consolidation baseline, and private baseline exclusions persist in SQLite. The React layer currently owns device control settings, generated-edit grouping, status, and displayed run results. The Tauri command applies optimizer proposals as edits with a short direction/objective note, but it does not persist the full request, score components, exclusions, or plan. Reopening a project preserves the resulting genome but not enough data to reproduce an optimizer run exactly.

## Engine boundary

The Rust `dgw-core` crate has no Tauri dependency. This allows state, VCF, sequence, and evaluation behavior to be tested in headless environments. The desktop crate converts Tauri commands into core calls and retains the persistent evaluation service for the application lifetime.

SQLite uses WAL mode and foreign keys. Structured payloads are stored as JSON alongside indexed identifiers; this keeps early schema evolution explicit without spreading biological state across frontend storage.

## Reference access

hs37d5 is BGZF-compressed. DGW calculates uncompressed byte offsets from the FAI line geometry and asks bgzip for only the focused range using the GZI index. It then materializes each genome copy of the selected track by applying active variants in reverse coordinate order.

## Failure behavior

Projects can reopen from their frozen root artifact when the original VCF moves. Missing resources disable live evaluation but do not invalidate tracks or provenance. Worker errors, resource unavailability, and no-match results remain separate states.
