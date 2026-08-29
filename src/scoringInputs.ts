export type ScoringInputState = "included" | "excluded" | "bypassed" | "notApplied";

export interface ScoringInputDefinition {
  id: string;
  sourceDeviceId?: string;
}

export interface ScoringObjectiveDefinition {
  includedWeightIds?: readonly string[];
}

export function scoringInputState(
  objective: ScoringObjectiveDefinition | undefined,
  input: ScoringInputDefinition,
  bypassedDeviceIds: ReadonlySet<string>,
  appliedDeviceIds?: ReadonlySet<string>
): ScoringInputState {
  if (!objective?.includedWeightIds?.includes(input.id)) return "excluded";
  if (input.sourceDeviceId && appliedDeviceIds && !appliedDeviceIds.has(input.sourceDeviceId)) return "notApplied";
  if (input.sourceDeviceId && bypassedDeviceIds.has(input.sourceDeviceId)) return "bypassed";
  return "included";
}

export function effectiveScoringWeights(
  configuredWeights: Readonly<Record<string, number>>,
  objective: ScoringObjectiveDefinition | undefined,
  inputs: readonly ScoringInputDefinition[],
  bypassedDeviceIds: ReadonlySet<string>,
  appliedDeviceIds?: ReadonlySet<string>
): Record<string, number> {
  return Object.fromEntries(inputs.map((input) => [
    input.id,
    scoringInputState(objective, input, bypassedDeviceIds, appliedDeviceIds) === "included"
      ? configuredWeights[input.id] ?? 0
      : 0
  ]));
}
