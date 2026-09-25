export type Haplotype = "one" | "two" | "unphased";

export interface IndexedResource {
  path: string;
  indexPath: string;
  release: string;
  licenseLabel: string;
  contigStyle?: "chr_prefix" | "no_chr_prefix";
}

export interface GeneAnnotationResource {
  path: string;
  indexPath: string;
  assembly: string;
  contigStyle: string;
  release: string;
  sourceUrl: string;
  licenseLabel: string;
  fingerprint?: {
    path: string;
    sha256: string;
    size: number;
    modifiedUnix?: number;
  };
}

export interface ConsequenceAnnotationResource {
  path: string;
  assembly: string;
  contigStyle: string;
  release: string;
  sourceUrl: string;
  licenseLabel: string;
  fingerprint?: {
    path: string;
    sha256: string;
    size: number;
    modifiedUnix?: number;
  };
}

export interface ResourceBundle {
  schemaVersion: number;
  id: string;
  assembly: string;
  contigStyle: string;
  referencePath: string;
  referenceFaiPath: string;
  referenceGziPath?: string;
  bcftoolsPath: string;
  bcftoolsVersion: string;
  bgzipPath: string;
  tabixPath: string;
  clinvar: IndexedResource;
  cosmic: IndexedResource;
  geneAnnotation?: GeneAnnotationResource;
  consequenceAnnotation?: ConsequenceAnnotationResource;
  bundleFingerprint?: string;
}

export type ResourceHealthStatus = "ready" | "warning" | "missing" | "notConfigured" | "error";

export interface ResourceHealthItem {
  id: "toolchain" | "reference" | "consequence" | "genes" | "clinvar" | "cosmic";
  label: string;
  status: ResourceHealthStatus;
  summary: string;
  paths: string[];
}

export interface ProjectResourceHealth {
  bundleId: string;
  assembly: string;
  checkedAt: string;
  status: ResourceHealthStatus;
  items: ResourceHealthItem[];
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
  inputContigStyle: "chr_prefix" | "no_chr_prefix" | "mixed";
  recordCount: number;
  passRecordCount: number;
  nonPassRecordCount: number;
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
  unphasedSlot?: number;
  origin: "observed" | "edited" | "created";
  editIds: string[];
  sourceKey?: VariantKey;
  sourceInfo: Record<string, string>;
}

export interface TrackComparisonLocus {
  contig: string;
  position: number;
  reference: string;
  source: EffectiveVariant[];
  current: EffectiveVariant[];
  changed: boolean;
}
export interface TrackComparisonPage {
  trackId: string;
  revision: string;
  offset: number;
  limit: number;
  totalLoci: number;
  matchingLoci: number;
  changedLoci?: number | null;
  hasMore: boolean;
  rows: TrackComparisonLocus[];
}

export interface ComparisonMapStrip {
  contig: string;
  start: number;
  end: number;
  bins: Array<{ start: number; end: number; total: number; changed: number; sequence: number; altCopies: number; placement: number }>;
}
export interface TrackComparisonMap {
  revision: string;
  strips: ComparisonMapStrip[];
  rows: TrackComparisonLocus[];
  rowTypes: Array<"sequence" | "altCopies" | "placement" | null>;
}

export interface PredictionComparisonReport { revision: string; deviceIds: string[]; counts: Record<string, number>; total: number }
export interface PredictionComparisonRow { outcome: string; locus: TrackComparisonLocus; evidence: Record<string, EvidenceResult> }
export interface PredictionComparisonPage { stale: boolean; total: number; rows: PredictionComparisonRow[]; consequences?: string[]; impacts?: string[] }

export interface GenomeState {
  id: string;
  parentId?: string;
  editId?: string;
  label?: string;
  createdAt: string;
}

export type EditKind =
  | { kind: "setAllele"; key: VariantKey; sourceKey?: VariantKey; unphasedSlot?: number }
  | { kind: "restoreReference"; sourceKey: VariantKey }
  | { kind: "compoundMutationLayer"; layerId: string; positionCount: number; changeCount: number };

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

export interface GeneSearchHit {
  geneId: string;
  symbol: string;
  contig: string;
  start: number;
  end: number;
  strand: string;
  biotype?: string;
  sourceVariantCount: number;
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
  sourceVariantTotal: number;
  variantsTruncated: boolean;
}

export interface VariantPage {
  trackId: string;
  offset: number;
  limit: number;
  total: number;
  variants: EffectiveVariant[];
  hasMore: boolean;
}

export interface VariantContigSummary {
  contig: string;
  total: number;
  minPosition: number;
  maxPosition: number;
}

export interface VariantNavigationBin {
  contig: string;
  start: number;
  end: number;
  total: number;
}

export interface ProcessProgress {
  operation: string;
  stage: string;
  message: string;
  step: number;
  totalSteps: number;
}

export type BackgroundJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJob<TResult = unknown> {
  id: string;
  operation: string;
  deviceId: string;
  trackId: string;
  status: BackgroundJobStatus;
  progress: number;
  stage: string;
  message: string;
  workerThreads: number;
  request: unknown;
  result?: TResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrackProfileDeviceCoverage {
  id: string;
  evaluated: number;
  total: number;
  exactMatches: number;
  unavailable: number;
  errors: number;
  noTranscriptFeature: number;
}

export interface TrackEvidenceProfileResult {
  trackId: string;
  stateId: string;
  profileInputFingerprint?: string;
  activeMutations: number;
  evaluatedMutations: number;
  impactDelta?: number;
  higherImpactMutations?: number;
  lowerImpactMutations?: number;
  unchangedImpactMutations?: number;
  deviceCoverage: TrackProfileDeviceCoverage[];
  limitation: string;
}

export type MorphOrdering = "genomic" | "seededRandom";

export interface TrackMorphRequest {
  amount: number;
  ordering: MorphOrdering;
  seed: number;
}

export interface TrackMorphPreviewResult {
  sourceTrackId: string;
  sourceStateId: string;
  targetTrackId: string;
  targetStateId: string;
  amount: number;
  differingPositions: number;
  differingAlleles: number;
  selectedPositions: number;
  generatedEdits: number;
  noOpReason?: string;
  limitation: string;
  compoundLayerId?: string;
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

export type TransportTargetKind = "variants" | "activeEdits";
export type TransportAction = "locate" | "first" | "last" | "previous" | "next";

export interface TransportCursor {
  sourceKey: VariantKey;
  editId?: string;
  compoundOrdinal?: number;
}

export interface TransportTargetRequest {
  selection: VariantSelection;
  targetKind: TransportTargetKind;
  action: TransportAction;
  cursor?: TransportCursor;
  wrap?: boolean;
}

export interface TransportTarget {
  cursor: TransportCursor;
  sourceKey: VariantKey;
  currentVariant?: EffectiveVariant;
  editId?: string;
  locusStatus: "alternate" | "reference";
  ordinal: number;
  total: number;
  wrapped: boolean;
}

export interface TransportTargetResult {
  target?: TransportTarget;
  total: number;
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

export interface OptimizerExclusion {
  sourceVariant: VariantKey;
  haplotype: Haplotype;
  reason: string;
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
  exclusions: OptimizerExclusion[];
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

export interface OptimizerBackgroundResult {
  mode: OptimizerMode;
  direction: OptimizerDirection;
  consideredPositions: number;
  evaluatedCandidates: number;
  excludedPositions: number;
  improvingPositions: number;
  unchangedOrTiedPositions: number;
  deferredByChangeLimit: number;
  changedPositions: number;
  generatedEdits: number;
  scoreBefore: number;
  scoreAfter: number;
  scoreDescription: string;
  limitation: string;
  noOpReason?: string;
  candidateComparisonsRetained: number;
  compoundLayerId?: string;
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

export interface RandomizerPreviewResult {
  selectedPositions: number;
  randomizedPositions: number;
  transitionPositions: number;
  transversionPositions: number;
  generatedEdits: number;
  excludedPositions: number;
  changeCount: number;
  changes: Array<{
    contig: string;
    position: number;
    from: string;
    to: string;
    substitutionClass: "transition" | "transversion";
  }>;
  noOpReason?: string;
  limitation: string;
  compoundLayerId?: string;
}

export interface RandomizerRunResult {
  plan: RandomizerPlan;
  generatedEditIds: string[];
  snapshot: ProjectSnapshot;
}

export interface CompoundLayerApplyResult {
  generatedEditId: string;
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
  copiedFromProjectId?: string;
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
  consequence: EvidenceResult;
  clinvar: EvidenceResult;
  cosmic: EvidenceResult;
  evaluatedAt: string;
  limitation: string;
}

export type DeviceKind = "analysis" | "evidence" | "editing" | "visualization";
export type DeviceCapability = "analyzeAllele" | "lookupEvidence" | "proposeEdits" | "visualizeTrack";

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
