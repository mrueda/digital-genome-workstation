import type { Page } from "@playwright/test";

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
      dbnsfp: { path: "/synthetic/dbnsfp.vcf.gz", indexPath: "/synthetic/dbnsfp.vcf.gz.tbi", release: "4.1a", licenseLabel: "dbNSFP terms" },
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
    const sourceVariants = positions.map((position, index) => ({
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
    const states = [
      rootState,
      { id: "state-restored", parentId: "state-root", editId: "edit-restored", createdAt: now, label: "Restore BRAF" },
      { id: "state-alternative", parentId: "state-root", editId: "edit-alternative", createdAt: now, label: "Alternative BRAF ALT" }
    ];
    const tracks = [sourceTrack, restoredTrack, alternativeTrack];
    const lanes = [
      { track: sourceTrack, edits: [], variants: sourceVariants, sourceVariantTotal: 10, variantsTruncated: false },
      { track: restoredTrack, edits: [restoredEdit], variants: restoredVariants, sourceVariantTotal: 10, variantsTruncated: false },
      { track: alternativeTrack, edits: [alternativeEdit], variants: alternativeVariants, sourceVariantTotal: 10, variantsTruncated: false }
    ];
    const focus = { contig: "7", start: 140_453_090, end: 140_453_190 };
    let activeTrackId = restoredTrack.id;

    function activeTrack() {
      return tracks.find((track) => track.id === activeTrackId) ?? restoredTrack;
    }

    function activeVariants() {
      return lanes.find((lane) => lane.track.id === activeTrackId)?.variants ?? restoredVariants;
    }

    function snapshot() {
      const active = activeTrack();
      return {
        manifest: {
          projectId: "dgw-e2e-project",
          name: "DGW Allele Editing Demo",
          selectedSample: "DGW_DEMO",
          assembly: "b37",
          resourceBundle: bundle,
          rootStateId: "state-root",
          sourceVcf: { path: "/synthetic/dgw-cluster.synthetic.vcf", sha256: "synthetic", size: 2048 }
        },
        workspace: { currentStateId: active.headStateId, bypassedEditIds: [], focus, activeTrackId },
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
      ["org.dgw.builtin.dbnsfp", "dbNSFP", "evidence", "Look up exact functional evidence."],
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
          "org.dgw.builtin.dbnsfp",
          "org.dgw.builtin.clinvar",
          "org.dgw.builtin.cosmic"
        ].map((id) => ({ id, evaluated: mutationCount, total: mutationCount, exactMatches: id === "org.dgw.builtin.variant-consequences" ? mutationCount : 0, unavailable: 0, errors: 0, noTranscriptFeature: 0 })),
        limitation: "Synthetic documentation fixture"
      };
    }

    async function command(commandName: string, args: JsonObject = {}) {
      if (commandName === "plugin:webview|set_webview_zoom") return null;
      if (commandName === "suggested_development_bundles") return [bundle];
      if (commandName === "example_fixture") return { path: "/synthetic/dgw-cluster.synthetic.vcf", sample: "DGW_DEMO", projectName: "DGW Allele Editing Demo", projectPath: "/synthetic/DGW-Allele-Editing-Demo.dgw" };
      if (commandName === "create_project") { activeTrackId = sourceTrack.id; return snapshot(); }
      if (commandName === "duplicate_track") {
        activeTrackId = String(args.name).includes("alternative") ? alternativeTrack.id : restoredTrack.id;
        return snapshot();
      }
      if (commandName === "apply_edit") return states.find((state) => state.id === activeTrack().headStateId) ?? rootState;
      if (commandName === "select_track") { activeTrackId = String(args.trackId); return snapshot(); }
      if (commandName === "open_project") return snapshot();
      if (commandName === "load_workstation_session") return null;
      if (commandName === "save_workstation_session") return now;
      if (commandName === "device_catalog") return deviceCatalog;
      if (commandName === "list_background_jobs") return [];
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
        if (deviceId === "org.dgw.builtin.variant-consequences") return { source: "Variant Consequences", status: "found", records: [{ impact: "HIGH", consequence: "missense_variant", transcript: "ENST00000288602", engine: "bcftools csq 1.24" }] };
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
      invoke: command
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: internals });
  });
}
