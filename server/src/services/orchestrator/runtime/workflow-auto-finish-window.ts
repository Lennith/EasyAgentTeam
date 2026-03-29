export interface WorkflowAutoFinishWindowInput {
  previousStableTicks: number;
  unfinishedTaskCount: number;
  runningSessionCount: number;
  requiredStableTicks: number;
}

export interface WorkflowAutoFinishWindowResult {
  eligible: boolean;
  stableTicks: number;
  previousStableTicks: number;
  reset: boolean;
  shouldFinalize: boolean;
}

export function evaluateWorkflowAutoFinishWindow(input: WorkflowAutoFinishWindowInput): WorkflowAutoFinishWindowResult {
  const eligible = input.unfinishedTaskCount === 0 && input.runningSessionCount === 0;
  if (!eligible) {
    return {
      eligible: false,
      stableTicks: 0,
      previousStableTicks: input.previousStableTicks,
      reset: input.previousStableTicks > 0,
      shouldFinalize: false
    };
  }

  const stableTicks = input.previousStableTicks + 1;
  return {
    eligible: true,
    stableTicks,
    previousStableTicks: input.previousStableTicks,
    reset: false,
    shouldFinalize: stableTicks >= input.requiredStableTicks
  };
}
