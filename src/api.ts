import { invoke } from "@tauri-apps/api/core";
import type {
  DeviceManifest,
  EditKind,
  ExampleFixture,
  EvidenceResult,
  EvaluationResult,
  FocusContext,
  FocusFastaExport,
  FocusView,
  GenomeTrackLane,
  GenomeState,
  Haplotype,
  OptimizerRequest,
  OptimizerRunResult,
  ProjectSnapshot,
  RandomizerPlan,
  RandomizerRequest,
  RandomizerRunResult,
  ResourceBundle,
  VariantKey,
  VcfInspection,
  WorkspaceSnapshot
} from "./types";

export const api = {
  deviceCatalog: () => invoke<DeviceManifest[]>("device_catalog"),
  suggestedBundle: () => invoke<ResourceBundle>("suggested_development_bundle"),
  exampleFixture: () => invoke<ExampleFixture>("example_fixture"),
  validateBundle: (bundle: ResourceBundle) =>
    invoke<string[]>("validate_bundle", { bundle }),
  inspectVcf: (path: string) =>
    invoke<VcfInspection>("inspect_vcf_file", { path, assembly: "b37" }),
  createProject: (request: {
    projectPath: string;
    name: string;
    sourceVcfPath: string;
    selectedSample: string;
    resourceBundle: ResourceBundle;
  }) => invoke<ProjectSnapshot>("create_project", { request }),
  openProject: (path: string) => invoke<ProjectSnapshot>("open_project", { path }),
  focusRegion: (projectPath: string, context: FocusContext) =>
    invoke<FocusView>("focus_region", { projectPath, context }),
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
  trackDeck: (projectPath: string) =>
    invoke<GenomeTrackLane[]>("track_deck", { projectPath }),
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
  consolidateTrack: (projectPath: string, trackId: string) =>
    invoke<ProjectSnapshot>("consolidate_track", { projectPath, trackId }),
  runOptimizer: (projectPath: string, trackId: string, focus: FocusContext, request: OptimizerRequest) =>
    invoke<OptimizerRunResult>("run_optimizer", { projectPath, trackId, focus, request }),
  previewRandomizer: (projectPath: string, trackId: string, request: RandomizerRequest) =>
    invoke<RandomizerPlan>("preview_randomizer", { projectPath, trackId, request }),
  runRandomizer: (projectPath: string, trackId: string, request: RandomizerRequest) =>
    invoke<RandomizerRunResult>("run_randomizer", { projectPath, trackId, request }),
  setTrackEditBypass: (projectPath: string, trackId: string, editId: string, bypassed: boolean) =>
    invoke<ProjectSnapshot>("set_track_edit_bypass", { projectPath, trackId, editId, bypassed }),
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
