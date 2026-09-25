import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  DeviceManifest,
  BackgroundJob,
  CompoundLayerApplyResult,
  CreatedProject,
  EditKind,
  ExampleFixture,
  EvidenceResult,
  EvaluationResult,
  FocusContext,
  FocusFastaExport,
  FocusView,
  GeneSearchHit,
  GenomeTrackLane,
  GenomeState,
  Haplotype,
  OptimizerRequest,
  OptimizerBackgroundResult,
  OptimizerRunResult,
  ProcessProgress,
  ProjectResourceHealth,
  ProjectSnapshot,
  RandomizerPreviewResult,
  RandomizerRequest,
  RandomizerRunResult,
  ResourceBundle,
  VariantKey,
  VariantContigSummary,
  VariantNavigationBin,
  VariantDensity,
  VariantPage,
  TrackComparisonPage,
  TrackComparisonMap,
  PredictionComparisonReport,
  PredictionComparisonPage,
  VariantSelection,
  SelectionResolution,
  TrackEvidenceProfileResult,
  TrackMorphPreviewResult,
  TrackMorphRequest,
  TransportTargetRequest,
  TransportTargetResult,
  VcfInspection,
  WorkspaceSnapshot
} from "./types";

export interface ResourceInstallProgress { stage: string; message: string; completedBytes: number; totalBytes: number }
export interface ResourceInventory {
  directory: string;
  platform: string;
  issues: string[];
  releases: Array<{ id: string; name: string; version: string; assembly: string; platform: string; files: Array<{ bytes: number; unpackedBytes?: number }> }>;
  installed: Array<{ bundle: ResourceBundle; descriptor: string; ready: boolean; message: string }>;
}

export const api = {
  checkAppUpdates: () => invoke<{ currentVersion: string; latestVersion?: string; status: "available" | "current" | "unavailable"; message: string }>("check_app_updates"),
  openAppReleases: () => invoke<void>("open_app_releases"),
  openAppDocumentation: () => invoke<void>("open_app_documentation"),
  resourceInventory: () => invoke<ResourceInventory>("resource_inventory"),
  setResourceDirectory: (path: string) => invoke<void>("set_resource_directory", { path }),
  registerResourceBundle: (path: string) => invoke<void>("register_resource_bundle", { path }),
  addCosmicResource: (descriptor: string, path: string, release: string) => invoke<void>("add_cosmic_resource", { descriptor, path, release }),
  installResourceRelease: (releaseId: string, onProgress: (progress: ResourceInstallProgress) => void) => {
    const channel = new Channel<ResourceInstallProgress>();
    channel.onmessage = onProgress;
    return invoke<void>("install_resource_release", { releaseId, onProgress: channel });
  },
  installDownloadedPackages: (paths: string[], onProgress: (progress: ResourceInstallProgress) => void) => {
    const channel = new Channel<ResourceInstallProgress>();
    channel.onmessage = onProgress;
    return invoke<void>("install_downloaded_packages", { paths, onProgress: channel });
  },
  deviceCatalog: () => invoke<DeviceManifest[]>("device_catalog"),
  suggestedBundles: () => invoke<ResourceBundle[]>("suggested_development_bundles"),
  exampleFixture: (assembly: "b37" | "hg38", exampleId = "alleleEditing") =>
    invoke<ExampleFixture>("example_fixture", { assembly, exampleId }),
  validateBundle: (bundle: ResourceBundle) =>
    invoke<string[]>("validate_bundle", { bundle }),
  inspectVcf: (path: string, assembly: string, onProgress?: (progress: ProcessProgress) => void) => {
    const channel = new Channel<ProcessProgress>();
    channel.onmessage = (progress) => onProgress?.(progress);
    return invoke<VcfInspection>("inspect_vcf_file", { path, assembly, onProgress: channel });
  },
  createProject: (request: {
    projectPath: string;
    name: string;
    sourceVcfPath: string;
    selectedSample: string;
    resourceBundle: ResourceBundle;
  }, onProgress?: (progress: ProcessProgress) => void) => {
    const channel = new Channel<ProcessProgress>();
    channel.onmessage = (progress) => onProgress?.(progress);
    return invoke<ProjectSnapshot>("create_project", { request, onProgress: channel });
  },
  createProjectFromCurrent: (currentProjectPath: string, templateId: "standardEvidence" | "empty") =>
    invoke<CreatedProject>("create_project_from_current", { currentProjectPath, templateId }),
  openProject: (path: string) => invoke<ProjectSnapshot>("open_project", { path }),
  projectResourceHealth: (projectPath: string) =>
    invoke<ProjectResourceHealth>("project_resource_health", { projectPath }),
  loadWorkstationSession: <TSession = unknown>(projectPath: string) =>
    invoke<TSession | null>("load_workstation_session", { projectPath }),
  saveWorkstationSession: (projectPath: string, session: unknown) =>
    invoke<string>("save_workstation_session", { projectPath, session }),
  saveProjectCopy: (projectPath: string, destinationPath: string) =>
    invoke<CreatedProject>("save_project_copy", { projectPath, destinationPath }),
  focusRegion: (projectPath: string, context: FocusContext) =>
    invoke<FocusView>("focus_region", { projectPath, context }),
  trackComparisonMap: (projectPath: string, trackId: string, selection: VariantSelection, context?: FocusContext, bins = 128) =>
    invoke<TrackComparisonMap>("track_comparison_map", { projectPath, trackId, selection, context, bins }),
  searchGenes: (projectPath: string, query: string, limit = 12) =>
    invoke<GeneSearchHit[]>("search_genes", { projectPath, query, limit }),
  exportFocusFasta: (
    projectPath: string,
    trackId: string,
    context: FocusContext,
    outputPath: string
  ) => invoke<FocusFastaExport>("export_focus_fasta", {
    projectPath,
    trackId,
    context,
    outputPath
  }),
  trackDeck: (projectPath: string, context?: FocusContext) =>
    invoke<GenomeTrackLane[]>("track_deck", { projectPath, context }),
  variantPage: (projectPath: string, trackId: string, offset = 0, limit = 200) =>
    invoke<VariantPage>("variant_page", { projectPath, trackId, offset, limit }),
  trackComparisonPage: (projectPath: string, trackId: string, selection: VariantSelection, offset = 0, limit = 200, changedOnly = false, search = "") =>
    invoke<TrackComparisonPage>("track_comparison_page", { projectPath, trackId, selection, offset, limit, changedOnly, search }),
  startPredictionComparison: (projectPath: string, trackId: string, deviceIds: string[], workerThreads: number, selection: VariantSelection) =>
    invoke<BackgroundJob<PredictionComparisonReport>>("start_prediction_comparison_job", { projectPath, trackId, deviceIds, workerThreads, selection }),
  predictionComparisonPage: (projectPath: string, jobId: string, deviceIds: string[], outcome: string | undefined, offset: number) =>
    invoke<PredictionComparisonPage>("prediction_comparison_page", { projectPath, jobId, deviceIds, outcome, offset }),
  variantContigs: (projectPath: string) =>
    invoke<VariantContigSummary[]>("variant_contigs", { projectPath }),
  variantNavigationBins: (projectPath: string, contig: string, bins = 16, start?: number, end?: number) =>
    invoke<VariantNavigationBin[]>("variant_navigation_bins", { projectPath, contig, bins, start, end }),
  variantDensity: (projectPath: string, trackId: string, context: FocusContext) =>
    invoke<VariantDensity>("variant_density", { projectPath, trackId, context }),
  resolveVariantSelection: (projectPath: string, selection: VariantSelection, limit: number) =>
    invoke<SelectionResolution>("resolve_variant_selection", { projectPath, selection, limit }),
  transportTarget: (projectPath: string, request: TransportTargetRequest) =>
    invoke<TransportTargetResult>("transport_target", { projectPath, request }),
  saveWorkspace: (projectPath: string, workspace: WorkspaceSnapshot) =>
    invoke<ProjectSnapshot>("save_workspace", { projectPath, workspace }),
  selectTrack: (projectPath: string, trackId: string) =>
    invoke<ProjectSnapshot>("select_track", { projectPath, trackId }),
  duplicateTrack: (projectPath: string, trackId: string, name: string) =>
    invoke<ProjectSnapshot>("duplicate_track", { projectPath, trackId, name }),
  renameTrack: (projectPath: string, trackId: string, name: string) =>
    invoke<ProjectSnapshot>("rename_track", { projectPath, trackId, name }),
  deleteTrack: (projectPath: string, trackId: string) =>
    invoke<ProjectSnapshot>("delete_track", { projectPath, trackId }),
  trackProfileInputFingerprint: (projectPath: string, trackId: string, deviceIds: string[]) =>
    invoke<string>("track_profile_input_fingerprint", { projectPath, trackId, deviceIds }),
  consolidateTrack: (projectPath: string, trackId: string) =>
    invoke<ProjectSnapshot>("consolidate_track", { projectPath, trackId }),
  runOptimizer: (projectPath: string, trackId: string, focus: FocusContext, request: OptimizerRequest) =>
    invoke<OptimizerRunResult>("run_optimizer", { projectPath, trackId, focus, request }),
  startOptimizerJob: (
    projectPath: string,
    trackId: string,
    focus: FocusContext,
    request: OptimizerRequest,
    selection: VariantSelection | undefined,
    selectionLimit: number | undefined,
    workerThreads: number
  ) => invoke<BackgroundJob<OptimizerBackgroundResult>>("start_optimizer_job", {
    projectPath,
    trackId,
    focus,
    request,
    selection,
    selectionLimit,
    workerThreads
  }),
  previewRandomizer: (
    projectPath: string,
    trackId: string,
    request: RandomizerRequest,
    selection?: VariantSelection,
    selectionLimit?: number
  ) => invoke<RandomizerPreviewResult>("preview_randomizer", {
    projectPath,
    trackId,
    request,
    selection,
    selectionLimit
  }),
  runRandomizer: (
    projectPath: string,
    trackId: string,
    request: RandomizerRequest,
    selection?: VariantSelection,
    selectionLimit?: number
  ) => invoke<RandomizerRunResult>("run_randomizer", {
    projectPath,
    trackId,
    request,
    selection,
    selectionLimit
  }),
  applyCompoundMutationLayer: (projectPath: string, trackId: string, layerId: string) =>
    invoke<CompoundLayerApplyResult>("apply_compound_mutation_layer", { projectPath, trackId, layerId }),
  startRandomizerPreviewJob: (
    projectPath: string,
    trackId: string,
    request: RandomizerRequest,
    selection: VariantSelection | undefined,
    selectionLimit: number | undefined,
    workerThreads: number
  ) => invoke<BackgroundJob<RandomizerPreviewResult>>("start_randomizer_preview_job", {
    projectPath,
    trackId,
    request,
    selection,
    selectionLimit,
    workerThreads
  }),
  backgroundJob: <TResult = unknown>(projectPath: string, jobId: string) =>
    invoke<BackgroundJob<TResult>>("background_job", { projectPath, jobId }),
  listBackgroundJobs: (projectPath: string, limit = 50) =>
    invoke<BackgroundJob[]>("list_background_jobs", { projectPath, limit }),
  deleteFinishedBackgroundJobs: (projectPath: string) =>
    invoke<number>("delete_finished_background_jobs", { projectPath }),
  cancelBackgroundJob: (projectPath: string, jobId: string) =>
    invoke<BackgroundJob>("cancel_background_job", { projectPath, jobId }),
  startTrackEvidenceProfileJob: (
    projectPath: string,
    trackId: string,
    deviceIds: string[],
    workerThreads: number
  ) => invoke<BackgroundJob<TrackEvidenceProfileResult>>("start_track_evidence_profile_job", {
    projectPath,
    trackId,
    deviceIds,
    workerThreads
  }),
  startTrackMorphPreviewJob: (
    projectPath: string,
    trackId: string,
    targetTrackId: string,
    request: TrackMorphRequest,
    workerThreads: number
  ) => invoke<BackgroundJob<TrackMorphPreviewResult>>("start_track_morph_preview_job", {
    projectPath,
    trackId,
    targetTrackId,
    request,
    workerThreads
  }),
  setTrackEditBypass: (projectPath: string, trackId: string, editId: string, bypassed: boolean) =>
    invoke<ProjectSnapshot>("set_track_edit_bypass", { projectPath, trackId, editId, bypassed }),
  setTrackEditsBypass: (projectPath: string, trackId: string, editIds: string[], bypassed: boolean) =>
    invoke<ProjectSnapshot>("set_track_edits_bypass", { projectPath, trackId, editIds, bypassed }),
  applyEdit: (
    projectPath: string,
    parentStateId: string,
    haplotype: Haplotype,
    edit: EditKind,
    bypassedEditIds: string[],
    note?: string,
    trackId?: string
  ) =>
    invoke<GenomeState>("apply_edit", {
      projectPath,
      trackId,
      parentStateId,
      haplotype,
      edit,
      note,
      bypassedEditIds
    }),
  evaluate: (projectPath: string, variant: VariantKey) =>
    invoke<EvaluationResult>("evaluate_variant", { projectPath, variant }),
  evaluateDevice: (projectPath: string, variant: VariantKey, deviceId: string) =>
    invoke<EvidenceResult>("evaluate_device", { projectPath, variant, deviceId }),
  render: (
    projectPath: string,
    stateId: string,
    bypassedEditIds: string[],
    outputPath: string
  ) =>
    invoke<string>("render_state", {
      projectPath,
      stateId,
      bypassedEditIds,
      outputPath
    }),
  renderTrack: (projectPath: string, trackId: string, outputPath: string) =>
    invoke<string>("render_track", { projectPath, trackId, outputPath })
};
