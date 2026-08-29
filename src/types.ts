export type Haplotype = "one" | "two" | "unphased";

export interface IndexedResource {
  path: string;
  indexPath: string;
  release: string;
  licenseLabel: string;
}

export interface ResourceBundle {
  schemaVersion: number;
  id: string;
  assembly: string;
  contigStyle: string;
  referencePath: string;
  referenceFaiPath: string;
  referenceGziPath?: string;
  javaPath: string;
  snpeffJarPath: string;
  snpeffConfigPath?: string;
  snpeffGenome: string;
  snpeffVersion: string;
  bcftoolsPath: string;
  bgzipPath: string;
  tabixPath: string;
  dbnsfp: IndexedResource;
  clinvar: IndexedResource;
  cosmic: IndexedResource;
  bundleFingerprint?: string;
}

export interface VariantKey {
  assembly: string;
  contig: string;
  position: number;
  reference: string;
  alternate: string;
}

export interface VcfInspection {
  path: string;
  fileFormat?: string;
  samples: string[];
  contigs: string[];
  recordCount: number;
  supportedRecordCount: number;
  skippedUnsupportedRecordCount: number;
  biallelic: boolean;
  sorted: boolean;
  firstVariant?: VariantKey;
  lastVariant?: VariantKey;
}

export interface ExampleFixture {
  path: string;
  sample: string;
  projectName: string;
  projectPath: string;
}

export interface EffectiveVariant {
  key: VariantKey;
  haplotype1Alt: boolean;
  haplotype2Alt: boolean;
  unphasedAlt: boolean;
  origin: "observed" | "edited" | "created";
  editIds: string[];
  sourceKey?: VariantKey;
  sourceInfo: Record<string, string>;
}

export interface GenomeState {
  id: string;
  parentId?: string;
  editId?: string;
  label?: string;
  createdAt: string;
}

export type EditKind =
  | { kind: "setAllele"; key: VariantKey; sourceKey?: VariantKey }
  | { kind: "restoreReference"; sourceKey: VariantKey };

export interface EditOperation {
  id: string;
  parentStateId: string;
  haplotype: Haplotype;
  edit: EditKind;
  note?: string;
  createdAt: string;
}

export interface FocusContext {
  contig: string;
  start: number;
  end: number;
}

export interface WorkspaceSnapshot {
  currentStateId: string;
  bypassedEditIds: string[];
  aStateId?: string;
  bStateId?: string;
  focus?: FocusContext;
  activeTrackId: string;
}

export interface GenomeTrack {
  id: string;
  name: string;
  baseStateId: string;
  headStateId: string;
  bypassedEditIds: string[];
  readOnly: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GenomeTrackLane {
  track: GenomeTrack;
  edits: EditOperation[];
  variants: EffectiveVariant[];
}

export interface VariantPage {
  trackId: string;
  offset: number;
  limit: number;
  total: number;
  variants: EffectiveVariant[];
  hasMore: boolean;
}

export interface VariantDensityBin {
  contig: string;
  start: number;
  end: number;
  count: number;
}

export interface VariantDensity {
  trackId: string;
  context: FocusContext;
  total: number;
  bins: VariantDensityBin[];
}

export type VariantSelection =
  | { kind: "explicit"; trackId: string; variants: VariantKey[] }
  | { kind: "interval"; trackId: string; contig: string; start: number; end: number; exclusions: VariantKey[] }
  | { kind: "allTrack"; trackId: string; exclusions: VariantKey[] };

export interface SelectionResolution {
  trackId: string;
  total: number;
  limit: number;
  variants: VariantKey[];
  truncated: boolean;
}

export type OptimizerObjectiveId = "alternateAlleleBurden" | "predictedImpactBurden";
export type OptimizerDirection = "minimize" | "maximize";
export type OptimizerMode = "conservative" | "saturation";

export interface OptimizerRequest {
  mode: OptimizerMode;
  objective: OptimizerObjectiveId;
  direction: OptimizerDirection;
  maxEdits: number;
  weights: {
    impact: number;
    clinvar: number;
    sourceEvidence: number;
  };
  selectedVariants: VariantKey[];
  evidenceDeviceIds: string[];
}

export interface OptimizerProposal {
  sourceVariant: VariantKey;
  haplotype: Haplotype;
  edit: EditKind;
  scoreBeforeContribution: number;
  scoreAfterContribution: number;
  scoreDelta: number;
  rationale: string;
}

export interface OptimizerCandidateComparison {
  sourceVariant: VariantKey;
  candidateVariant: VariantKey;
  current: boolean;
  selected: boolean;
  comparable: boolean;
  evidence: {
    impactSignal: number;
    impactLabel?: string;
    clinvarSignal: number;
    clinvarClassification?: string;
    sourceEvidenceSignal: number;
  };
  scoreComponents: {
    objectiveScore: number;
  };
  evidenceStatuses: Record<string, string>;
  exactEvidenceSources: string[];
  note?: string;
}

export interface OptimizerPlan {
  request: OptimizerRequest;
  focus: FocusContext;
  proposals: OptimizerProposal[];
  scoreBefore: number;
  scoreAfter: number;
  consideredVariants: number;
  eligibleCandidates: number;
  candidateComparisons: OptimizerCandidateComparison[];
  noOpReason?: string;
  scoreDescription: string;
  limitation: string;
  constraints: string[];
}

export interface OptimizerRunResult {
  plan: OptimizerPlan;
  generatedEditIds: string[];
  snapshot: ProjectSnapshot;
}

export interface RandomizerRequest {
  selectedVariants: VariantKey[];
  amount: number;
  seed: number;
  substitutionPattern: "uniform" | "transitionOnly" | "transversionOnly" | "tiTvMix";
  transitionProbability: number;
}

export interface RandomizerProposal {
  sourceVariant: VariantKey;
  replacementVariant: VariantKey;
  haplotype: Haplotype;
  edit: EditKind;
}

export interface RandomizerExclusion {
  sourceVariant: VariantKey;
  reason: string;
}

export interface RandomizerPlan {
  request: RandomizerRequest;
  proposals: RandomizerProposal[];
  exclusions: RandomizerExclusion[];
  selectedPositions: number;
  randomizedPositions: number;
  transitionPositions: number;
  transversionPositions: number;
  generatedEdits: number;
  noOpReason?: string;
  limitation: string;
}

export interface RandomizerRunResult {
  plan: RandomizerPlan;
  generatedEditIds: string[];
  snapshot: ProjectSnapshot;
}

export interface ProjectManifest {
  projectId: string;
  name: string;
  selectedSample: string;
  assembly: string;
  resourceBundle: ResourceBundle;
  rootStateId: string;
  sourceVcf: { path: string; sha256: string; size: number };
}

export interface ProjectSnapshot {
  manifest: ProjectManifest;
  workspace: WorkspaceSnapshot;
  tracks: GenomeTrack[];
  activeTrack: GenomeTrack;
  states: GenomeState[];
  variants: EffectiveVariant[];
  variantCount: number;
  warnings: string[];
}

export interface CreatedProject {
  projectPath: string;
  snapshot: ProjectSnapshot;
}

export interface FocusView {
  context: FocusContext;
  contigLength?: number;
  referenceSequence?: string;
  haplotype1Sequence?: string;
  haplotype2Sequence?: string;
  variants: EffectiveVariant[];
  states: GenomeState[];
  edits: EditOperation[];
  workspace: WorkspaceSnapshot;
  tracks: GenomeTrack[];
  activeTrack: GenomeTrack;
  warnings: string[];
}

export interface FocusFastaExport {
  fastaPath: string;
  uncertaintyPath?: string;
  sequenceRecords: number;
  maskedUnphasedAlleles: number;
}

export interface EvidenceResult {
  source: string;
  status: "found" | "noExactMatch" | "notComputed" | "resourceUnavailable" | "error";
  records: Array<Record<string, string>>;
  message?: string;
}

export interface EvaluationResult {
  variant: VariantKey;
  cacheKey: string;
  snpeff: EvidenceResult;
  dbnsfp: EvidenceResult;
  clinvar: EvidenceResult;
  cosmic: EvidenceResult;
  evaluatedAt: string;
  limitation: string;
}

export type DeviceKind = "analysis" | "evidence" | "editing";
export type DeviceCapability = "analyzeAllele" | "lookupEvidence" | "proposeEdits";

export interface DeviceManifest {
  manifestVersion: string;
  id: string;
  name: string;
  version: string;
  description: string;
  kind: DeviceKind;
  capabilities: DeviceCapability[];
  protocolVersion: string;
  supportedAssemblies: string[];
  inputSchemaIds: string[];
  outputSchemaIds: string[];
  scientificLimitations: string[];
}
