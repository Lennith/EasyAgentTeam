import { randomUUID } from "node:crypto";
import {
  addPendingMessagesForRole,
  confirmPendingMessagesForRole
} from "../../../data/repository/project/role-message-status-repository.js";
import {
  getRuntimeSettings,
  type RuntimeSettings
} from "../../../data/repository/system/runtime-settings-repository.js";
import {
  markRunnerFatalError,
  markRunnerStarted,
  markRunnerSuccess,
  markRunnerTimeout
} from "../../session-lifecycle-authority.js";
import type { MiniMaxRunResultInternal } from "../../minimax-runner.js";
import type { ProjectDispatchInput as ProviderProjectDispatchInput } from "../../provider-runtime.js";
import { ProjectDispatchEventAdapter } from "./project-dispatch-event-adapter.js";
import { isPendingSessionId } from "./project-dispatch-policy.js";
import {
  prepareProjectDispatchLaunch,
  type PreparedProjectDispatchLaunch
} from "./project-dispatch-launch-preparation.js";
import type {
  ProjectDispatchLaunchAdapterContext,
  ProjectDispatchLaunchContext,
  ProjectDispatchLaunchExecutionDependencies,
  ProjectDispatchLaunchOperations
} from "./project-dispatch-launch-adapter.js";
import type { SessionDispatchResult } from "./project-orchestrator-types.js";
import {
  appendProjectDispatchTerminalEventForContext,
  buildProjectDispatchProviderPayload,
  buildProjectDispatchRunnerScopePayload,
  buildProjectDispatchTerminalResult,
  finalizeProjectDispatchRunLifecycle,
  markProjectTaskDispatchedForContextIfNeeded
} from "./project-dispatch-run-lifecycle.js";

export const defaultProjectDispatchLaunchOperations: ProjectDispatchLaunchOperations = {
  now: () => new Date().toISOString(),
  createDispatchId: () => randomUUID(),
  getRuntimeSettings,
  prepareProjectDispatchLaunch,
  addPendingMessagesForRole,
  confirmPendingMessagesForRole,
  markRunnerStarted,
  markRunnerSuccess,
  markRunnerTimeout,
  markRunnerFatalError
};

async function handleProjectMiniMaxWakeUp(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  sessionId: string,
  runId: string
): Promise<void> {
  const { input } = context;
  await dependencies.operations.confirmPendingMessagesForRole(input.paths, input.project.projectId, input.session.role);
  await dependencies.helpers.markTaskDispatchedIfNeeded(context);
  await dependencies.operations.markRunnerStarted({
    ...dependencies.helpers.buildRunnerPayload(context, runId, sessionId),
    provider: "minimax"
  });
}

async function handleProjectMiniMaxCompletion(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  result: MiniMaxRunResultInternal,
  sessionId: string,
  runId: string
): Promise<void> {
  const { input } = context;
  await dependencies.operations.confirmPendingMessagesForRole(input.paths, input.project.projectId, input.session.role);
  const dispatchFailedReason = await finalizeProjectDispatchRunLifecycle(dependencies, context, {
    runId,
    sessionId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: result.error,
    provider: "minimax",
    providerSessionId: result.timedOut ? undefined : (result.sessionId ?? null)
  });
  await dependencies.helpers.appendTerminalDispatchEvent(context, sessionId, {
    dispatchFailedReason,
    runId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    finishedAt: result.finishedAt
  });
}

async function runProjectMiniMaxDispatch(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  prepared: PreparedProjectDispatchLaunch
): Promise<SessionDispatchResult> {
  const { input } = context;
  const runtimeSettings = await dependencies.operations.getRuntimeSettings(dependencies.context.dataRoot);
  await dependencies.operations.addPendingMessagesForRole(
    input.paths,
    input.project.projectId,
    input.session.role,
    input.selectedMessageIds.map((messageId) => ({
      messageId,
      dispatchedAt: new Date().toISOString()
    }))
  );

  let expectedRunId: string | null = null;
  const launchResult = await dependencies.context.providerRegistry.launchProjectDispatch(
    context.providerId,
    input.project,
    input.paths,
    dependencies.helpers.buildProviderDispatchPayload(context, prepared),
    runtimeSettings,
    {
      wakeUpCallback: async (sessionId, runId) => {
        if (expectedRunId && expectedRunId !== runId) {
          return;
        }
        await handleProjectMiniMaxWakeUp(dependencies, context, sessionId, runId);
      },
      completionCallback: async (result, sessionId, runId) => {
        if (expectedRunId && expectedRunId !== runId) {
          return;
        }
        await handleProjectMiniMaxCompletion(dependencies, context, result, sessionId, runId);
      }
    }
  );
  if (launchResult.mode !== "async") {
    throw new Error(`provider '${context.providerId}' expected async launch mode for project dispatch`);
  }
  expectedRunId = launchResult.runId;
  return {
    sessionId: input.session.sessionId,
    role: input.session.role,
    outcome: "dispatched",
    dispatchKind: input.dispatchKind,
    messageId: input.firstMessage.envelope.message_id,
    requestId: input.firstMessage.envelope.correlation.request_id,
    runId: launchResult.runId,
    exitCode: null,
    timedOut: false,
    taskId: input.taskId
  };
}

async function runProjectSyncDispatch(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  prepared: PreparedProjectDispatchLaunch
): Promise<SessionDispatchResult> {
  const { input } = context;
  const runtimeSettings = await dependencies.operations.getRuntimeSettings(dependencies.context.dataRoot);
  const resumeCandidate =
    input.session.providerSessionId?.trim() ||
    (!isPendingSessionId(input.session.sessionId) ? input.session.sessionId : "");
  const canAttemptResume = context.providerId === "codex" && Boolean(resumeCandidate);
  await dependencies.operations.markRunnerStarted({
    ...dependencies.helpers.buildRunnerPayload(context),
    provider: context.providerId
  });

  let run: {
    runId: string;
    exitCode: number | null;
    timedOut: boolean;
    finishedAt?: string;
    sessionId?: string;
    error?: string;
  } | null = null;
  let runError: unknown = null;
  let resumedFailedAndReset = false;

  try {
    const launchResult = await dependencies.context.providerRegistry.launchProjectDispatch(
      context.providerId,
      input.project,
      input.paths,
      dependencies.helpers.buildProviderDispatchPayload(context, prepared, { resumeSessionId: resumeCandidate }),
      runtimeSettings
    );
    if (launchResult.mode !== "sync") {
      throw new Error(`provider '${context.providerId}' returned async launch mode for sync project dispatch`);
    }
    run = launchResult.result;
  } catch (error) {
    runError = error;
  }

  if (canAttemptResume && runError !== null) {
    await dependencies.context.repositories.events.appendEvent(input.paths, {
      projectId: input.project.projectId,
      eventType: "CODEX_RESUME_FAILED",
      source: "manager",
      sessionId: input.session.sessionId,
      taskId: input.taskId,
      payload: {
        requestId: input.firstMessage.envelope.correlation.request_id,
        resumeSessionId: resumeCandidate || null,
        error: runError instanceof Error ? runError.message : String(runError)
      }
    });
    resumedFailedAndReset = true;
    await dependencies.context.repositories.sessions.touchSession(
      input.paths,
      input.project.projectId,
      input.session.sessionId,
      {
        providerSessionId: null
      }
    );
    run = null;
    runError = null;
    await dependencies.context.repositories.events.appendEvent(input.paths, {
      projectId: input.project.projectId,
      eventType: "CODEX_RESUME_FALLBACK_EXEC",
      source: "manager",
      sessionId: input.session.sessionId,
      taskId: input.taskId,
      payload: {
        requestId: input.firstMessage.envelope.correlation.request_id,
        previousResumeSessionId: resumeCandidate || null
      }
    });
    try {
      const fallbackResult = await dependencies.context.providerRegistry.launchProjectDispatch(
        context.providerId,
        input.project,
        input.paths,
        dependencies.helpers.buildProviderDispatchPayload(context, prepared),
        runtimeSettings
      );
      if (fallbackResult.mode !== "sync") {
        throw new Error(`provider '${context.providerId}' returned async launch mode for sync project dispatch`);
      }
      run = fallbackResult.result;
    } catch (fallbackError) {
      runError = fallbackError;
    }
  }

  if (runError || !run) {
    throw runError instanceof Error ? runError : new Error(runError ? String(runError) : "model run failed");
  }

  if (input.dispatchKind === "message") {
    await dependencies.operations.addPendingMessagesForRole(
      input.paths,
      input.project.projectId,
      input.session.role,
      input.selectedMessageIds.map((messageId) => ({
        messageId,
        dispatchedAt: new Date().toISOString()
      }))
    );
  }
  await dependencies.operations.confirmPendingMessagesForRole(input.paths, input.project.projectId, input.session.role);
  await dependencies.helpers.markTaskDispatchedIfNeeded(context);

  const nextProviderSessionId = run.sessionId ?? (resumedFailedAndReset ? undefined : resumeCandidate || undefined);
  const dispatchFailedReason = await finalizeProjectDispatchRunLifecycle(dependencies, context, {
    runId: run.runId,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    error: run.error,
    provider: context.providerId,
    providerSessionId: nextProviderSessionId ?? null
  });
  await dependencies.helpers.appendTerminalDispatchEvent(context, input.session.sessionId, {
    dispatchFailedReason,
    runId: run.runId,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    finishedAt: run.finishedAt ?? new Date().toISOString()
  });

  return buildProjectDispatchTerminalResult(context, run, dispatchFailedReason);
}

export function buildProjectDispatchExecutionDependencies(
  context: ProjectDispatchLaunchAdapterContext,
  operations: ProjectDispatchLaunchOperations,
  eventAdapter: ProjectDispatchEventAdapter
): ProjectDispatchLaunchExecutionDependencies {
  return {
    context,
    operations,
    helpers: {
      buildProviderDispatchPayload: (
        launchContext: ProjectDispatchLaunchContext,
        prepared: PreparedProjectDispatchLaunch,
        extra: Partial<ProviderProjectDispatchInput> = {}
      ) => buildProjectDispatchProviderPayload(launchContext, prepared, extra),
      buildRunnerPayload: (launchContext: ProjectDispatchLaunchContext, runId?: string, sessionId?: string) =>
        buildProjectDispatchRunnerScopePayload(context.dataRoot, launchContext, runId, sessionId),
      appendTerminalDispatchEvent: (
        launchContext: ProjectDispatchLaunchContext,
        sessionId: string,
        details: {
          dispatchFailedReason: string | null;
          runId: string;
          exitCode: number | null;
          timedOut: boolean;
          finishedAt: string;
        }
      ) =>
        appendProjectDispatchTerminalEventForContext(
          eventAdapter,
          context.repositories,
          launchContext,
          sessionId,
          details
        ),
      markTaskDispatchedIfNeeded: (launchContext: ProjectDispatchLaunchContext) =>
        markProjectTaskDispatchedForContextIfNeeded(context.repositories, launchContext)
    }
  };
}

export async function runProjectDispatchProviderLaunch(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  prepared: PreparedProjectDispatchLaunch
): Promise<SessionDispatchResult> {
  if (context.providerId === "minimax") {
    return await runProjectMiniMaxDispatch(dependencies, context, prepared);
  }
  return await runProjectSyncDispatch(dependencies, context, prepared);
}
