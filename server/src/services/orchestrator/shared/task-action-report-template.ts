export interface BuildOrchestratorTaskReportAppliedEventPayloadInput<
  TRejectedResult,
  TExtraPayload extends Record<string, unknown> = Record<string, never>
> {
  fromAgent: string;
  appliedTaskIds: string[];
  rejectedResults: TRejectedResult[];
  includeRejectedResults?: boolean;
  extraPayload?: TExtraPayload;
}

export type OrchestratorTaskReportAppliedEventPayload<
  TRejectedResult,
  TExtraPayload extends Record<string, unknown> = Record<string, never>
> = {
  fromAgent: string;
  appliedTaskIds: string[];
  updatedTaskIds: string[];
  rejectedCount: number;
  rejectedResults?: TRejectedResult[];
} & TExtraPayload;

export function buildOrchestratorTaskReportAppliedEventPayload<
  TRejectedResult,
  TExtraPayload extends Record<string, unknown> = Record<string, never>
>(
  input: BuildOrchestratorTaskReportAppliedEventPayloadInput<TRejectedResult, TExtraPayload>
): OrchestratorTaskReportAppliedEventPayload<TRejectedResult, TExtraPayload> {
  const payload: Record<string, unknown> = {
    fromAgent: input.fromAgent,
    appliedTaskIds: [...input.appliedTaskIds],
    updatedTaskIds: [...input.appliedTaskIds],
    rejectedCount: input.rejectedResults.length,
    ...(input.extraPayload ?? {})
  };
  if (input.includeRejectedResults) {
    payload.rejectedResults = input.rejectedResults;
  }
  return payload as OrchestratorTaskReportAppliedEventPayload<TRejectedResult, TExtraPayload>;
}

export interface BuildOrchestratorTaskReportActionResultInput<
  TActionType extends string,
  TRejectedResult,
  TExtraResult extends Record<string, unknown> = Record<string, never>
> {
  actionType: TActionType;
  appliedTaskIds: string[];
  rejectedResults: TRejectedResult[];
  extraResult?: TExtraResult;
}

export type OrchestratorTaskReportActionResult<
  TActionType extends string,
  TRejectedResult,
  TExtraResult extends Record<string, unknown> = Record<string, never>
> = {
  success: true;
  actionType: TActionType;
  partialApplied: boolean;
  appliedTaskIds: string[];
  rejectedResults: TRejectedResult[];
} & TExtraResult;

export function buildOrchestratorTaskReportActionResult<
  TActionType extends string,
  TRejectedResult,
  TExtraResult extends Record<string, unknown> = Record<string, never>
>(
  input: BuildOrchestratorTaskReportActionResultInput<TActionType, TRejectedResult, TExtraResult>
): OrchestratorTaskReportActionResult<TActionType, TRejectedResult, TExtraResult> {
  return {
    success: true,
    actionType: input.actionType,
    partialApplied: input.rejectedResults.length > 0,
    appliedTaskIds: [...input.appliedTaskIds],
    rejectedResults: input.rejectedResults,
    ...(input.extraResult ?? {})
  } as OrchestratorTaskReportActionResult<TActionType, TRejectedResult, TExtraResult>;
}
