import type { Page } from "@playwright/test";
import type { EffectiveVariant, GenomeTrackLane, GenomeState, EditKind } from "../src/types";

export async function installTauriShellMock(page: Page) {
  await page.addInitScript(() => {
    type Callback = (payload: unknown) => void;
    type JsonObject = Record<string, unknown>;

    const bundle = {
      schemaVersion: 1,
      id: "dgw-e2e-grch37",
      assembly: "b37",
      contigStyle: "no_chr_prefix",
      referencePath: "/synthetic/hs37d5.fa",
      referenceFaiPath: "/synthetic/hs37d5.fa.fai",
      bcftoolsPath: "/synthetic/bcftools",
      bcftoolsVersion: "1.24",
      bgzipPath: "/synthetic/bgzip",
      tabixPath: "/synthetic/tabix",
      clinvar: { path: "/synthetic/clinvar.vcf.gz", indexPath: "/synthetic/clinvar.vcf.gz.tbi", release: "2025-03", licenseLabel: "Public domain" },
      cosmic: { path: "/synthetic/cosmic.vcf.gz", indexPath: "/synthetic/cosmic.vcf.gz.tbi", release: "v101", licenseLabel: "COSMIC terms" },
      geneAnnotation: {
        path: "/synthetic/Homo_sapiens.GRCh37.87.gtf.gz",
        indexPath: "/synthetic/ensembl-grch37.87.genes.json",
        assembly: "b37",
        contigStyle: "no_chr_prefix",
        release: "Ensembl 87",
        sourceUrl: "https://www.ensembl.org",
        licenseLabel: "Ensembl terms"
      },
      consequenceAnnotation: {
        path: "/synthetic/Homo_sapiens.GRCh37.87.gff3.gz",
        assembly: "b37",
        contigStyle: "no_chr_prefix",
        release: "Ensembl 87",
        sourceUrl: "https://www.ensembl.org",
        licenseLabel: "Ensembl terms"
      }
    };
    const hg38Bundle = {
      ...bundle,
      id: "dgw-e2e-grch38",
      assembly: "hg38",
      contigStyle: "chr_prefix",
      referencePath: "/synthetic/hg38.fa",
      referenceFaiPath: "/synthetic/hg38.fa.fai",
      geneAnnotation: { ...bundle.geneAnnotation, assembly: "hg38", release: "Ensembl 116" },
      consequenceAnnotation: { ...bundle.consequenceAnnotation, assembly: "hg38", release: "Ensembl 116" }
    };
    const now = "2026-09-03T12:00:00Z";
    const rootState = { id: "state-root", createdAt: now, label: "Imported source" };
    const sourceTrack = {
      id: "track-source",
      name: "DGW_DEMO source",
      baseStateId: "state-root",
      headStateId: "state-root",
      bypassedEditIds: [],
      readOnly: true,
      archived: false,
      createdAt: now,
      updatedAt: now
    };
    const restoredTrack = {
      id: "track-restored",
      name: "BRAF · restore to REF",
      baseStateId: "state-root",
      headStateId: "state-restored",
      bypassedEditIds: [],
      readOnly: false,
      archived: false,
      createdAt: now,
      updatedAt: now
    };
    const alternativeTrack = {
      id: "track-alternative",
      name: "BRAF · alternative ALT",
      baseStateId: "state-root",
      headStateId: "state-alternative",
      bypassedEditIds: [],
      readOnly: false,
      archived: false,
      createdAt: now,
      updatedAt: now
    };
    const positions = [140_453_105, 140_453_112, 140_453_121, 140_453_136, 140_453_148, 140_453_161, 140_453_176];
    const refs = ["C", "G", "T", "A", "C", "G", "T"];
    const alts = ["T", "A", "C", "T", "G", "T", "C"];
    const sourceVariants: EffectiveVariant[] = positions.map((position, index) => ({
      key: { assembly: "b37", contig: "7", position, reference: refs[index], alternate: alts[index] },
      haplotype1Alt: index % 3 === 0,
      haplotype2Alt: index % 3 === 1,
      unphasedAlt: index % 3 === 2,
      origin: "observed",
      editIds: [],
      sourceInfo: {}
    }));
    const brafSourceKey = sourceVariants[3].key;
    const restoredEdit = {
      id: "edit-restored",
      parentStateId: "state-root",
      haplotype: "one",
      edit: { kind: "restoreReference", sourceKey: brafSourceKey },
      note: "Restore the selected BRAF ALT to the reference base",
      createdAt: now
    };
    const alternativeEdit = {
      id: "edit-alternative",
      parentStateId: "state-root",
      haplotype: "one",
      edit: {
        kind: "setAllele",
        sourceKey: brafSourceKey,
        key: { ...brafSourceKey, alternate: "C" }
      },
      note: "Try another possible SNV allele at this position",
      createdAt: now
    };
    const restoredVariants = sourceVariants.filter((variant) => variant.key.position !== brafSourceKey.position);
    const alternativeVariants = sourceVariants.map((variant) => variant.key.position === brafSourceKey.position
      ? { ...variant, key: { ...variant.key, alternate: "C" }, origin: "edited", editIds: ["edit-alternative"], sourceKey: brafSourceKey }
      : variant);
    const states: GenomeState[] = [
      rootState,
      { id: "state-restored", parentId: "state-root", editId: "edit-restored", createdAt: now, label: "Restore BRAF" },
      { id: "state-alternative", parentId: "state-root", editId: "edit-alternative", createdAt: now, label: "Alternative BRAF ALT" }
    ];
    const tracks = [sourceTrack, restoredTrack, alternativeTrack];
    const lanes: GenomeTrackLane[] = [
      { track: sourceTrack, edits: [], variants: sourceVariants, sourceVariantTotal: 10, variantsTruncated: false },
      { track: restoredTrack, edits: [restoredEdit], variants: restoredVariants, sourceVariantTotal: 10, variantsTruncated: false },
      { track: alternativeTrack, edits: [alternativeEdit], variants: alternativeVariants, sourceVariantTotal: 10, variantsTruncated: false }
    ];
    const focus = { contig: "7", start: 140_453_090, end: 140_453_190 };
    let activeTrackId = restoredTrack.id;
    let exampleKind: "synthetic" | "wes" = "synthetic";
    let exampleAssembly: "b37" | "hg38" = "b37";
    let workspaceFocus = focus;
    let mutableEdits = false;
    const initialVariants = new Map(lanes.map(lane => [lane.track.id, structuredClone(lane.variants)]));
    const appliedOperations: Array<{ trackId: string; id: string; edit: EditKind; haplotype: string }> = [];

    // Small stateful interaction fixture, not a biological evaluator. Rust tests
    // remain authoritative for normalization, multi-copy edits and scoring.
    function replayEdits(trackId: string) {
      const lane = lanes.find(item => item.track.id === trackId)!;
      let variants = structuredClone(initialVariants.get(trackId)!);
      for (const operation of appliedOperations.filter(item => item.trackId === trackId)) {
        if (lane.track.bypassedEditIds.includes(operation.id)) continue;
        const edit = operation.edit;
        if (edit.kind === "compoundMutationLayer") throw Error("Unsupported interaction fixture edit");
        const sourceKey = edit.sourceKey;
        const source = variants.find(item => JSON.stringify(item.key) === JSON.stringify(sourceKey));
        if (!source) continue; // An earlier operation may be bypassed.
        variants = variants.filter(item => item !== source);
        if (edit.kind === "setAllele") variants.push({ ...source, key: edit.key,
          sourceKey: source.sourceKey ?? source.key, origin: "edited", editIds: [operation.id] });
      }
      lane.variants = variants.sort((a, b) => a.key.position - b.key.position);
    }

    function activeTrack() {
      return tracks.find((track) => track.id === activeTrackId) ?? restoredTrack;
    }

    function activeVariants() {
      return lanes.find((lane) => lane.track.id === activeTrackId)?.variants ?? restoredVariants;
    }

    function snapshot() {
      const active = activeTrack();
      const activeBundle = exampleAssembly === "hg38" ? hg38Bundle : bundle;
      const projectName = exampleKind === "wes" ? "HG00103 exome — GRCh37" : "DGW Allele Editing Demo";
      const selectedSample = exampleKind === "wes" ? "SRR1596639" : "DGW_DEMO";
      const sourcePath = exampleKind === "wes"
        ? "/synthetic/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz"
        : "/synthetic/dgw-cluster.synthetic.vcf";
      return {
        manifest: {
          projectId: "dgw-e2e-project",
          name: projectName,
          selectedSample,
          assembly: activeBundle.assembly,
          resourceBundle: activeBundle,
          rootStateId: "state-root",
          sourceVcf: { path: sourcePath, sha256: "synthetic", size: 2048 }
        },
        workspace: { currentStateId: active.headStateId, bypassedEditIds: [], focus: workspaceFocus, activeTrackId },
        tracks,
        activeTrack: active,
        states,
        variants: activeVariants(),
        variantCount: 10,
        warnings: []
      };
    }

    const deviceCatalog = [
      ["org.dgw.builtin.mutation-generator", "Mutation Generator", "editing", "Generate controlled variant changes."],
      ["org.dgw.builtin.genome-morph", "Genome Morph", "editing", "Move one track toward another track."],
      ["org.dgw.builtin.variant-consequences", "Variant Consequences", "evidence", "Predict transcript consequences with bcftools csq."],
      ["org.dgw.builtin.clinvar", "ClinVar", "evidence", "Look up exact ClinVar records."],
      ["org.dgw.builtin.cosmic", "COSMIC", "evidence", "Look up exact COSMIC records."],
      ["org.dgw.builtin.genome-optimizer", "Genome Optimizer", "analysis", "Generate bounded score-directed edits."],
      ["org.dgw.builtin.variant-map", "Variant Map", "visualization", "Map source-relative impact changes."]
    ].map(([id, name, kind, description]) => ({
      manifestVersion: "1",
      id,
      name,
      version: "0.1.0",
      description,
      kind,
      capabilities: kind === "editing" ? ["proposeEdits"] : kind === "visualization" ? ["visualizeTrack"] : kind === "analysis" ? ["proposeEdits"] : ["lookupEvidence"],
      protocolVersion: "1",
      supportedAssemblies: ["b37", "hg38"],
      inputSchemaIds: [],
      outputSchemaIds: [],
      scientificLimitations: ["Synthetic documentation fixture"]
    }));

    function profile(trackId: string) {
      const mutationCount = lanes.find((lane) => lane.track.id === trackId)?.edits.length ?? 0;
      return {
        trackId,
        stateId: tracks.find((track) => track.id === trackId)?.headStateId ?? "state-root",
        profileInputFingerprint: `profile-${trackId}`,
        activeMutations: mutationCount,
        evaluatedMutations: mutationCount,
        impactDelta: trackId === "track-alternative" ? -0.33 : -1,
        higherImpactMutations: 0,
        lowerImpactMutations: mutationCount,
        unchangedImpactMutations: 0,
        deviceCoverage: [
          "org.dgw.builtin.variant-consequences",
          "org.dgw.builtin.clinvar",
          "org.dgw.builtin.cosmic"
        ].map((id) => ({ id, evaluated: mutationCount, total: mutationCount, exactMatches: id === "org.dgw.builtin.variant-consequences" ? mutationCount : 0, unavailable: 0, errors: 0, noTranscriptFeature: 0 })),
        limitation: "Synthetic documentation fixture"
      };
    }

    const sessions = new Map<string, unknown>();
    let failNextSessionSave = false;
    let largeComparison = false;
    let failComparison = false;
    let predictionJob: JsonObject | undefined;
    let stalePrediction = false;
    async function command(commandName: string, args: JsonObject = {}) {
      if (commandName === "test_stale_prediction") { stalePrediction = true; return null; }
      if (commandName === "user_setup_info") return { platform: "linux", version: "0.1.0", suggestedParent: "/synthetic/user/apps" };
      if (commandName === "install_for_user") {
        if (args.parent === "/existing" && !args.replaceExisting) throw new Error("Enable Replace existing installation to update it.");
        if (args.parent === "/unwritable") throw Error("Cannot write to this folder; choose one you own");
        return `${args.parent}/DGW-0.1.0/DGW.AppImage`;
      }
      if (commandName === "launch_user_install") {
        if (localStorage.getItem("test-launch-failure")) throw new Error("DGW closed during startup. Details: setup-launch.log");
        return null;
      }
      if (commandName === "start_prediction_comparison_job") {
        stalePrediction = false;
        predictionJob = { id: "prediction-test-job", operation: "trackPredictionComparison", deviceId: "org.dgw.builtin.variant-consequences", trackId: args.trackId, status: "queued", progress: 0, message: "Queued", stage: "queued", workerThreads: args.workerThreads, request: { deviceIds: args.deviceIds }, result: undefined, createdAt: now, updatedAt: now };
        return predictionJob;
      }
      if (commandName === "background_job" && args.jobId === predictionJob?.id) {
        predictionJob = { ...predictionJob, status: "completed", progress: 100, message: "Prediction comparison ready", result: { revision: "fixture", deviceIds: [], counts: { different: 1, same: 1, missing: 1, referenceRestoration: 1 }, total: 4 } };
        return predictionJob;
      }
      if (commandName === "cancel_background_job" && args.jobId === predictionJob?.id) {
        predictionJob = { ...predictionJob, status: "cancelled", message: "Comparison cancelled" }; return predictionJob;
      }
      if (commandName === "prediction_comparison_page") {
        const outcomes = ["different", "same", "missing", "referenceRestoration"];
        const rows = outcomes.map((outcome, i) => {
          const source = sourceVariants[i]; const current = { ...source, key: { ...source.key, alternate: ["A", "C", "G", "T"].find(base => base !== source.key.reference && base !== source.key.alternate)! } };
          const stable = (key: typeof source.key) => [key.assembly, key.contig, key.position, key.reference, key.alternate].join("|");
          const evidence = { source: "Variant Consequences", status: "found", records: [{ featureId: "TEST_TRANSCRIPT", effect: "stop_gained", impact: "HIGH" }] };
          const currentEvidence = outcome === "different" ? { ...evidence, records: [{ featureId: "TEST_TRANSCRIPT", effect: "missense", impact: "MODERATE" }] } : outcome === "missing" ? { ...evidence, status: "unavailable", records: [] } : evidence;
          return { outcome, locus: { contig: source.key.contig, position: source.key.position, reference: source.key.reference, source: [source], current: outcome === "referenceRestoration" ? [] : [current], changed: true }, evidence: { [stable(source.key)]: evidence, [stable(current.key)]: currentEvidence } };
        }).filter(row => !args.outcome || row.outcome === args.outcome);
        return { stale: stalePrediction, total: stalePrediction ? 0 : rows.length, rows: stalePrediction ? [] : rows.slice(Number(args.offset), Number(args.offset) + 200) };
      }
      if (commandName === "test_fail_next_comparison") { failComparison = true; return null; }
      if (commandName === "test_large_comparison") { largeComparison = true; return null; }
      if (commandName === "track_comparison_page") {
        if (failComparison) { failComparison = false; throw Error("Synthetic comparison read failure"); }
        const offset = Number(args.offset);
        const limit = Math.min(200, Number(args.limit ?? 200));
        const sources = largeComparison ? Array.from({ length: 205 }, (_, index) => ({ ...sourceVariants[0], key: { ...sourceVariants[0].key, contig: index < 200 ? "7" : "17", position: 1000 + index } })) : sourceVariants;
        const rows = sources.map((source, index) => ({
            contig: source.key.contig, position: source.key.position, reference: source.key.reference,
            source: [source], current: index === 204 ? [] : [source], changed: index === 204
          }));
        const matches = args.changedOnly ? rows.filter(row => row.changed) : rows;
        return { trackId: String(args.trackId), revision: "comparison-fixture-v1", offset, limit, totalLoci: sources.length,
          matchingLoci: matches.length, changedLoci: args.changedOnly ? rows.filter(row => row.changed).length : undefined,
          hasMore: offset + limit < matches.length, rows: matches.slice(offset, offset + limit) };
      }
      if (commandName === "test_fail_next_session_save") { failNextSessionSave = true; return null; }
      if (commandName === "plugin:dialog|open") return "/synthetic/DGW-Allele-Editing-Demo.dgw";
      if (commandName === "test_enable_mutable_edits") { mutableEdits = true; return null; }
      if (commandName === "plugin:webview|set_webview_zoom") return null;
      if (commandName === "suggested_development_bundles") return localStorage.getItem("test-no-resources") ? [] : [bundle, hg38Bundle];
      if (commandName === "resource_inventory") return {
        directory: "/synthetic/resources", platform: "linux-aarch64", issues: [],
        releases: [], installed: []
      };
      if (commandName === "example_fixture") {
        exampleKind = args.exampleId === "hg00103Wes" ? "wes" : "synthetic";
        exampleAssembly = args.assembly === "hg38" ? "hg38" : "b37";
        if (exampleKind === "wes") {
          return { path: "/synthetic/1000G-HG00103.SRR1596639.wes.b37.public.vcf.gz", sample: "SRR1596639", projectName: "HG00103 exome — GRCh37", projectPath: "/synthetic/HG00103-WES.dgw" };
        }
        return { path: "/synthetic/dgw-cluster.synthetic.vcf", sample: "DGW_DEMO", projectName: "DGW Allele Editing Demo", projectPath: "/synthetic/DGW-Allele-Editing-Demo.dgw" };
      }
      if (commandName === "create_project") { activeTrackId = exampleKind === "synthetic" ? sourceTrack.id : restoredTrack.id; return snapshot(); }
      if (commandName === "duplicate_track") {
        activeTrackId = String(args.name).includes("alternative") ? alternativeTrack.id : restoredTrack.id;
        return snapshot();
      }
      if (commandName === "apply_edit") {
        if (!mutableEdits) return states.find(state => state.id === activeTrack().headStateId) ?? rootState;
        const lane = lanes.find(item => item.track.id === args.trackId)!;
        if (lane.track.readOnly) throw Error("Source track is read-only");
        const edit = args.edit as EditKind;
        if (edit.kind === "compoundMutationLayer") throw Error("Unsupported interaction fixture edit");
        const source = lane.variants.find(item => JSON.stringify(item.key) === JSON.stringify(edit.sourceKey));
        if (!source) throw Error("Selected source allele is absent");
        if (Number(source.haplotype1Alt) + Number(source.haplotype2Alt) + Number(source.unphasedAlt) !== 1) throw Error("Fixture supports single-copy edits only");
        const id = `test-edit-${appliedOperations.length + 1}`;
        const state = { id: `state-${id}`, parentId: lane.track.headStateId, editId: id, createdAt: now };
        lane.edits.push({ id, parentStateId: lane.track.headStateId, haplotype: args.haplotype as "one" | "two" | "unphased", edit, createdAt: now });
        lane.track.headStateId = state.id;
        appliedOperations.push({ trackId: lane.track.id, id, edit, haplotype: String(args.haplotype) });
        states.push(state);
        replayEdits(lane.track.id);
        return state;
      }
      if (commandName === "set_track_edit_bypass" || commandName === "set_track_edits_bypass") {
        const lane = lanes.find(item => item.track.id === args.trackId)!;
        const ids = commandName === "set_track_edit_bypass" ? [String(args.editId)] : args.editIds as string[];
        lane.track.bypassedEditIds = args.bypassed
          ? [...new Set([...lane.track.bypassedEditIds, ...ids])]
          : lane.track.bypassedEditIds.filter(id => !ids.includes(id));
        replayEdits(lane.track.id);
        return snapshot();
      }
      if (commandName === "select_track") { activeTrackId = String(args.trackId); return snapshot(); }
      if (commandName === "rename_track") {
        activeTrackId = String(args.trackId);
        activeTrack().name = String(args.name);
        return snapshot();
      }
      if (commandName === "search_genes") {
        return String(args.query).toUpperCase() === "LDLR"
          ? [{ geneId: "ENSG00000130164", symbol: "LDLR", contig: "19", start: 11_200_038, end: 11_244_506, strand: "+", biotype: "protein_coding", sourceVariantCount: 5 }]
          : [{ geneId: "ENSG00000215568", symbol: "GAB4", contig: "chr22", start: 16_961_936, end: 17_008_222, strand: "-", biotype: "protein_coding", sourceVariantCount: 48 }];
      }
      if (commandName === "resolve_variant_selection") return { trackId: activeTrackId, total: 4, limit: 100, variants: sourceVariants.slice(0, 4).map((variant) => variant.key), truncated: false };
      if (commandName === "run_optimizer") return { plan: { proposals: [{ sourceVariant: sourceVariants[0].key }] }, generatedEditIds: ["edit-restored"], snapshot: snapshot() };
      if (commandName === "save_workspace") {
        const workspace = args.workspace as { focus?: typeof focus };
        if (workspace.focus) workspaceFocus = workspace.focus;
        return snapshot();
      }
      if (commandName === "open_project") return snapshot();
      if (commandName === "load_workstation_session") return structuredClone(sessions.get(String(args.projectPath)) ?? null);
      if (commandName === "save_workstation_session") {
        if (failNextSessionSave) { failNextSessionSave = false; throw Error("Synthetic session write failure"); }
        sessions.set(String(args.projectPath), structuredClone(args.session));
        return now;
      }
      if (commandName === "device_catalog") return deviceCatalog;
      if (commandName === "list_background_jobs") return predictionJob ? [predictionJob] : [];
      if (commandName === "variant_contigs") return [
        { contig: "7", total: 7, minPosition: positions[0], maxPosition: positions.at(-1) },
        { contig: "17", total: 3, minPosition: 7_674_220, maxPosition: 7_674_310 }
      ];
      if (commandName === "variant_navigation_bins") {
        const contig = String(args.contig);
        return contig === "7"
          ? [{ contig: "7", start: 140_453_090, end: 140_453_190, total: 7 }]
          : [{ contig: "17", start: 7_674_200, end: 7_674_330, total: 3 }];
      }
      if (commandName === "track_deck") return lanes;
      if (commandName === "focus_region") {
        const context = (args.context ?? focus) as typeof focus;
        const sequence = "GCTACAGTGACCTGAGGAGACATGAGGACCTGCAGCAAGCTGCCGAAGTGGATGGCCAGGACCTGAGGAGACATGAGGACCTGCAGCAAGCTGCCGAA".slice(0, context.end - context.start + 1);
        return {
          context,
          contigLength: 159_138_663,
          referenceSequence: sequence,
          haplotype1Sequence: sequence,
          haplotype2Sequence: sequence,
          variants: activeVariants().filter((variant) => variant.key.position >= context.start && variant.key.position <= context.end),
          states,
          edits: lanes.find((lane) => lane.track.id === activeTrackId)?.edits ?? [],
          workspace: { currentStateId: activeTrack().headStateId, bypassedEditIds: [], focus: context, activeTrackId },
          tracks,
          activeTrack: activeTrack(),
          warnings: []
        };
      }
      if (commandName === "variant_density") {
        const context = (args.context ?? focus) as typeof focus;
        return { trackId: activeTrackId, context, total: 7, bins: positions.map((position) => ({ contig: "7", start: position, end: position, count: 1 })) };
      }
      if (commandName === "track_profile_input_fingerprint") return `profile-${String(args.trackId)}`;
      if (commandName === "start_track_evidence_profile_job") {
        const trackId = String(args.trackId);
        return { id: `job-${trackId}`, operation: "trackEvidenceProfile", deviceId: "org.dgw.builtin.track-profiler", trackId, status: "completed", progress: 100, stage: "complete", message: "Profile complete", workerThreads: 1, request: {}, result: profile(trackId), createdAt: now, updatedAt: now };
      }
      if (commandName === "evaluate_device") {
        const deviceId = String(args.deviceId);
        if (deviceId === "org.dgw.builtin.variant-consequences") return { source: "Variant Consequences", status: "found", records: [
          { impact: "HIGH", effect: "stop_gained", featureId: "ENST00000288602", engine: "bcftools csq 1.24" },
          { impact: "LOW", effect: "synonymous", featureId: "ENST00000479537", engine: "bcftools csq 1.24", raw: "Synthetic second transcript record" }
        ] };
        return { source: deviceId.split(".").at(-1), status: "noExactMatch", records: [], message: "No exact allele match in the configured release." };
      }
      throw new Error(`Unhandled browser-test command: ${commandName}`);
    }

    const callbacks = new Map<number, { callback: Callback; once: boolean }>();
    let callbackId = 1;
    const internals = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      callbacks: {} as Record<number, Callback>,
      transformCallback(callback: Callback, once = false) {
        const id = callbackId++;
        callbacks.set(id, { callback, once });
        internals.callbacks[id] = callback;
        return id;
      },
      unregisterCallback(id: number) { callbacks.delete(id); delete internals.callbacks[id]; },
      runCallback(id: number, payload: unknown) {
        const entry = callbacks.get(id);
        entry?.callback(payload);
        if (entry?.once) internals.unregisterCallback(id);
      },
      convertFileSrc(path: string) { return path; },
      invoke: async (name: string, args?: JsonObject) => structuredClone(await command(name, args))
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: internals });
  });
}
