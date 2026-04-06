export type OrchestratorDispatchSelectionKind = "task" | "message";

export interface NormalizedDispatchSelectionResult<TSession = unknown, TMessage = unknown> {
  role: string;
  session: TSession;
  dispatchKind: OrchestratorDispatchSelectionKind | null;
  taskId: string | null;
  message: TMessage | null;
  messageId: string | null;
  requestId: string | null;
  skipReason?: string;
  terminalOutcome?: string;
}

export interface OrchestratorDispatchSelectionAdapter<
  TScopeContext = unknown,
  TSelectionInput = void,
  TSelectionResult = unknown
> {
  select(scope: TScopeContext, input: TSelectionInput): Promise<TSelectionResult>;
}

export type OrchestratorDispatchSelectionDecision<TSelection = unknown, TResult = unknown> =
  | {
      status: "selected";
      selection: TSelection;
    }
  | {
      status: "skipped";
      result: TResult;
    }
  | {
      status: "none";
      busyFound: boolean;
    };

export interface OrchestratorDispatchPreflightAdapter<TState = unknown, TResult = unknown> {
  beforeLoop(state: TState): Promise<TResult | null>;
  beforeIteration?(state: TState): Promise<TResult | null>;
}

export interface OrchestratorDispatchMutationAdapter<TState = unknown, TSelection = unknown, TPrepared = void> {
  prepareDispatch(selection: TSelection, state: TState): Promise<TPrepared>;
}

export interface OrchestratorBackgroundDispatchResult<TResult = unknown> {
  mode: "background";
  result: TResult;
  completion: Promise<unknown>;
  onError?(error: unknown): void | Promise<void>;
}

export interface OrchestratorDispatchExecutionAdapter<
  TState = unknown,
  TSelection = unknown,
  TPrepared = void,
  TResult = unknown
> {
  selectNext(state: TState): Promise<OrchestratorDispatchSelectionDecision<TSelection, TResult>>;
  getSingleFlightKey(selection: TSelection, state: TState): string;
  createSingleFlightBusyResult(selection: TSelection, state: TState): TResult;
  dispatch(
    selection: TSelection,
    prepared: TPrepared,
    state: TState
  ): Promise<TResult | OrchestratorBackgroundDispatchResult<TResult>>;
  buildNoSelectionResult(state: TState, busyFound: boolean): TResult | null;
  shouldCountAsDispatch?(result: TResult, state: TState): boolean;
  shouldContinue?(result: TResult, state: TState): boolean;
}

export interface OrchestratorDispatchFinalizeAdapter<TState = unknown, TResult = unknown> {
  afterDispatch?(result: TResult, state: TState): Promise<void>;
  afterLoop?(state: TState, results: TResult[]): Promise<void>;
}

export interface OrchestratorDispatchLifecycleEventAdapter<
  TScopeContext = unknown,
  TStartedDetails = unknown,
  TFinishedDetails = TStartedDetails,
  TFailedDetails = TFinishedDetails
> {
  appendStarted(scope: TScopeContext, details: TStartedDetails): Promise<void>;
  appendFinished(scope: TScopeContext, details: TFinishedDetails): Promise<void>;
  appendFailed(scope: TScopeContext, details: TFailedDetails): Promise<void>;
}

export interface OrchestratorDispatchLaunchAdapter<TLaunchInput = unknown, TLaunchResult = void> {
  launch(input: TLaunchInput): Promise<TLaunchResult>;
}

export interface OrchestratorRunnerLifecycleAdapter<TContext = unknown, TExecutionResult = unknown> {
  appendStarted(context: TContext): Promise<void>;
  appendSuccess?(context: TContext, result: TExecutionResult): Promise<void>;
  appendFailure?(context: TContext, error: unknown): Promise<void>;
  appendTimeout?(context: TContext, error: unknown): Promise<void>;
  appendEscalated?(context: TContext, error: unknown): Promise<void>;
}

export interface OrchestratorRunnerExecutionAdapter<
  TInput = unknown,
  TContext = unknown,
  TExecutionResult = unknown,
  TOutput = unknown
> {
  createContext(input: TInput): Promise<TContext>;
  execute(context: TContext): Promise<TExecutionResult>;
  onSuccess(context: TContext, result: TExecutionResult): Promise<TOutput>;
  onFailure(context: TContext, error: unknown): Promise<TOutput>;
  classifyFailure?(context: TContext, error: unknown): "failure" | "timeout" | "escalated";
  onEscalated?(context: TContext, error: unknown): Promise<TOutput>;
}

export interface OrchestratorLaunchExecutionAdapter<
  TInput = unknown,
  TContext = unknown,
  TExecutionResult = unknown,
  TOutput = unknown
> {
  createContext(input: TInput): Promise<TContext>;
  appendStarted(context: TContext): Promise<void>;
  appendSuccess?(context: TContext, result: TExecutionResult): Promise<void>;
  appendFailure?(context: TContext, error: unknown): Promise<void>;
  appendTimeout?(context: TContext, error: unknown): Promise<void>;
  appendEscalated?(context: TContext, error: unknown): Promise<void>;
  execute(context: TContext): Promise<TExecutionResult>;
  onSuccess(context: TContext, result: TExecutionResult): Promise<TOutput>;
  onFailure(context: TContext, error: unknown): Promise<TOutput>;
  classifyFailure?(context: TContext, error: unknown): "failure" | "timeout" | "escalated";
  onEscalated?(context: TContext, error: unknown): Promise<TOutput>;
}

export interface OrchestratorPromptFrame {
  scopeKind: "project" | "workflow";
  scopeId: string;
  role: string;
  sessionId: string | null;
  teamWorkspace: string;
  yourWorkspace: string;
  focusTaskId: string | null;
  visibleActionableTasks: string[];
  visibleBlockedTasks: string[];
  dependenciesReady: boolean;
  unresolvedDependencies: string[];
  executionContractLines: string[];
}

export interface OrchestratorPromptFrameBuilder<
  TContext = unknown,
  TFrame extends OrchestratorPromptFrame = OrchestratorPromptFrame
> {
  buildFrame(context: TContext): TFrame;
}

export interface OrchestratorMessageRoutingAdapter<
  TScope = unknown,
  TInput = unknown,
  TTarget = unknown,
  TEnvelope = unknown,
  TResult = unknown
> {
  resolveTarget(scope: TScope, input: TInput): Promise<TTarget>;
  normalizeEnvelope(scope: TScope, target: TTarget, input: TInput): Promise<TEnvelope>;
  runInUnitOfWork?(scope: TScope, input: TInput, operation: () => Promise<void>): Promise<void>;
  persistInbox(scope: TScope, target: TTarget, envelope: TEnvelope, input: TInput): Promise<void>;
  persistRouteEvent(scope: TScope, target: TTarget, envelope: TEnvelope, input: TInput): Promise<void>;
  touchSession(scope: TScope, target: TTarget, envelope: TEnvelope, input: TInput): Promise<void>;
  buildResult(scope: TScope, target: TTarget, envelope: TEnvelope, input: TInput): Promise<TResult>;
}

export interface OrchestratorTaskActionPipelineAdapter<
  TInput = unknown,
  TParsed = unknown,
  TAuthorized = TParsed,
  TGated = TAuthorized,
  TApplied = TGated,
  TConverged = TApplied,
  TOutput = TConverged
> {
  parse(input: TInput): Promise<TParsed>;
  authorize(parsed: TParsed): Promise<TAuthorized>;
  checkDependencyGate(authorized: TAuthorized): Promise<TGated>;
  apply(gated: TGated): Promise<TApplied>;
  convergeRuntime(applied: TApplied): Promise<TConverged>;
  emit(converged: TConverged): Promise<TOutput>;
}

export interface OrchestratorSessionRuntimeAdapter<TScopeContext = unknown> {
  markTimedOut(scope: TScopeContext): Promise<void>;
}

export interface OrchestratorReminderAdapter<TScopeContext = unknown> {
  checkReminders(scope: TScopeContext): Promise<void>;
}

export interface OrchestratorCompletionAdapter<TScopeContext = unknown> {
  finalize?(scope: TScopeContext): Promise<boolean>;
  runCompletion(scope: TScopeContext): Promise<void>;
  emitObservabilitySnapshot?(scope: TScopeContext): Promise<void>;
}
