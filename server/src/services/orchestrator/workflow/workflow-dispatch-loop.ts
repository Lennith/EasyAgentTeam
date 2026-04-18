import { randomUUID } from "node:crypto";
import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowSessionRecord } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { addWorkflowTaskTransition } from "../shared/runtime/workflow-runtime-kernel.js";
import type { OrchestratorSingleFlightGate } from "../shared/kernel/single-flight.js";
import type { WorkflowDispatchLaunchAdapter } from "./workflow-dispatch-launch-adapter.js";
import type {
  WorkflowDispatchSelection,
  WorkflowDispatchSelectionAdapter
} from "./workflow-dispatch-selection-adapter.js";
import { createTimestampedIdentifier, runOrchestratorDispatchTemplate } from "../shared/index.js";
import type { WorkflowDispatchResult, WorkflowDispatchRow } from "./workflow-dispatch-types.js";

interface WorkflowDispatchPrepared {
  dispatchId: string;
  messageId?: string;
}

export interface WorkflowDispatchLoopState {
  runId: string;
  run: WorkflowRunRecord;
  runtime: WorkflowRunRuntimeState;
  sessions: WorkflowSessionRecord[];
  role?: string;
  taskFilter?: string;
  force: boolean;
  onlyIdle: boolean;
  requestId: string;
  source: "manual" | "loop";
  remaining: number;
}

export interface WorkflowDispatchLoopInput {
  role?: string;
  taskId?: string;
  force?: boolean;
  onlyIdle?: boolean;
  maxDispatches?: number;
  source?: "manual" | "loop";
}

export interface WorkflowDispatchLoopContext {
  repositories: WorkflowRepositoryBundle;
  maxConcurrentDispatches: number;
  inFlightDispatchSessionKeys: OrchestratorSingleFlightGate;
  buildRunSessionKey(runId: string, sessionId: string): string;
  ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
}

export interface WorkflowDispatchRuntimeErrorFactory {
  (message: string, code: string, status?: number, nextAction?: string, details?: Record<string, unknown>): Error;
}

export interface WorkflowDispatchLoopDependencies {
  context: WorkflowDispatchLoopContext;
  launchAdapter: Pick<WorkflowDispatchLaunchAdapter, "launch">;
  selectionAdapter: Pick<WorkflowDispatchSelectionAdapter, "select">;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  handleLaunchError(error: unknown): void;
}

export async function loadWorkflowRunOrThrow(
  repositories: Pick<WorkflowRepositoryBundle, "workflowRuns">,
  createRuntimeError: WorkflowDispatchRuntimeErrorFactory,
  runId: string
): Promise<WorkflowRunRecord> {
  const run = await repositories.workflowRuns.getRun(runId);
  if (!run) {
    throw createRuntimeError(`run '${runId}' not found`, "RUN_NOT_FOUND", 404);
  }
  return run;
}

export async function createWorkflowDispatchLoopState(
  context: WorkflowDispatchLoopContext,
  loadRunOrThrowFn: (runId: string) => Promise<WorkflowRunRecord>,
  runId: string,
  input: WorkflowDispatchLoopInput = {}
): Promise<{ state: WorkflowDispatchLoopState; maxDispatches: number }> {
  const run = await loadRunOrThrowFn(runId);
  const requestId = createTimestampedIdentifier("", 6);
  const maxDispatchesRaw = Number(input.maxDispatches ?? 1);
  const maxDispatches = Number.isFinite(maxDispatchesRaw) && maxDispatchesRaw > 0 ? Math.floor(maxDispatchesRaw) : 1;
  return {
    state: {
      runId,
      run,
      runtime: await context.ensureRuntime(run),
      sessions: await context.repositories.sessions.listSessions(runId),
      role: input.role?.trim(),
      taskFilter: input.taskId?.trim(),
      force: Boolean(input.force),
      onlyIdle: Boolean(input.onlyIdle),
      requestId,
      source: input.source ?? "manual",
      remaining: Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5))
    },
    maxDispatches
  };
}

export async function runWorkflowDispatchLoop(
  dependencies: WorkflowDispatchLoopDependencies,
  state: WorkflowDispatchLoopState,
  maxDispatches: number
): Promise<{ results: WorkflowDispatchRow[]; dispatchedCount: number }> {
  return await runOrchestratorDispatchTemplate<
    WorkflowDispatchLoopState,
    WorkflowDispatchSelection,
    WorkflowDispatchPrepared,
    WorkflowDispatchRow
  >({
    state,
    gate: dependencies.context.inFlightDispatchSessionKeys,
    maxDispatches,
    preflight: {
      beforeLoop: async (loopState) => {
        if (loopState.run.status !== "running") {
          await dependencies.context.repositories.events.appendEvent(loopState.runId, {
            eventType: "ORCHESTRATOR_DISPATCH_FAILED",
            source: "system",
            payload: {
              requestId: loopState.requestId,
              error: "run_not_running"
            }
          });
          return {
            role: loopState.role ?? "any",
            sessionId: null,
            taskId: loopState.taskFilter ?? null,
            outcome: "run_not_running" as const,
            reason: "run is not running"
          };
        }
        if (loopState.run.holdEnabled && loopState.source === "loop") {
          return {
            role: loopState.role ?? "any",
            sessionId: null,
            taskId: loopState.taskFilter ?? null,
            outcome: "invalid_target" as const,
            reason: "run is on hold"
          };
        }
        return null;
      },
      beforeIteration: async (loopState) => {
        if (
          !loopState.force &&
          dependencies.context.inFlightDispatchSessionKeys.size >= dependencies.context.maxConcurrentDispatches
        ) {
          return {
            role: loopState.role ?? "any",
            sessionId: null,
            taskId: loopState.taskFilter ?? null,
            outcome: "session_busy" as const,
            reason: "max concurrent dispatches reached"
          };
        }
        return null;
      }
    },
    mutation: {
      prepareDispatch: async (selection, loopState) => {
        const dispatchId = randomUUID();
        const messageId = selection.messageId ?? selection.message?.envelope.message_id ?? undefined;
        if (selection.dispatchKind === "task" && selection.runtimeTask) {
          addWorkflowTaskTransition(loopState.runtime, selection.runtimeTask, "DISPATCHED", "dispatched");
        }

        await dependencies.context.repositories.sessions
          .touchSession(loopState.runId, selection.session.sessionId, {
            status: "running",
            currentTaskId: selection.taskId,
            lastDispatchedAt: new Date().toISOString(),
            lastDispatchId: dispatchId,
            lastDispatchedMessageId: messageId ?? null
          })
          .catch(() => {});

        selection.session.status = "running";
        selection.session.currentTaskId = selection.taskId ?? undefined;
        selection.session.lastDispatchId = dispatchId;
        if (selection.selectedMessageIds.length > 0) {
          await dependencies.context.repositories.inbox.removeInboxMessages(
            loopState.runId,
            selection.role,
            selection.selectedMessageIds
          );
        }
        if (!loopState.force && (loopState.run.autoDispatchEnabled ?? true) && selection.dispatchKind === "task") {
          loopState.remaining = Math.max(0, loopState.remaining - 1);
        }
        return {
          dispatchId,
          messageId
        };
      }
    },
    execution: {
      selectNext: async (loopState) =>
        await dependencies.selectionAdapter.select(
          {
            run: loopState.run,
            runtime: loopState.runtime,
            sessions: loopState.sessions
          },
          {
            role: loopState.role,
            taskId: loopState.taskFilter,
            force: loopState.force,
            onlyIdle: loopState.onlyIdle,
            requestId: loopState.requestId,
            remainingBudget: loopState.remaining
          }
        ),
      getSingleFlightKey: (selection, loopState) =>
        dependencies.context.buildRunSessionKey(loopState.runId, selection.session.sessionId),
      createSingleFlightBusyResult: (selection, loopState) => ({
        role: selection.role,
        sessionId: selection.session.sessionId,
        taskId: selection.taskId,
        dispatchKind: selection.dispatchKind,
        requestId: loopState.requestId,
        outcome: "session_busy" as const,
        reason: "session already dispatching"
      }),
      dispatch: async (selection, prepared, loopState) => ({
        mode: "background" as const,
        result: {
          role: selection.role,
          sessionId: selection.session.sessionId,
          taskId: selection.taskId,
          dispatchKind: selection.dispatchKind,
          messageId: prepared.messageId,
          requestId: loopState.requestId,
          outcome: "dispatched" as const
        },
        completion: dependencies.launchAdapter.launch({
          run: loopState.run,
          session: selection.session,
          role: selection.role,
          dispatchKind: selection.dispatchKind,
          taskId: selection.taskId,
          message: selection.message,
          requestId: loopState.requestId,
          messageId: prepared.messageId,
          dispatchId: prepared.dispatchId
        }),
        onError: async (error: unknown) => {
          dependencies.handleLaunchError(error);
        }
      }),
      buildNoSelectionResult: (loopState, busyFound) => ({
        role: loopState.role ?? "any",
        sessionId: null,
        taskId: loopState.taskFilter ?? null,
        outcome: busyFound ? "session_busy" : "no_task",
        ...(busyFound ? { reason: "session busy" } : {})
      }),
      shouldCountAsDispatch: (result) => result.outcome === "dispatched",
      shouldContinue: (result) => result.outcome === "dispatched"
    },
    finalize: {
      afterLoop: async (loopState, results) => {
        const dispatchedTaskIds = results
          .filter(
            (item) => item.outcome === "dispatched" && item.dispatchKind === "task" && typeof item.taskId === "string"
          )
          .map((item) => item.taskId as string);

        await dependencies.context.repositories.runInUnitOfWork({ run: loopState.run }, async () => {
          const freshRun = await dependencies.loadRunOrThrow(loopState.runId);
          const latestRuntime = await dependencies.context.readConvergedRuntime(freshRun);
          const latestByTask = new Map(latestRuntime.tasks.map((item) => [item.taskId, item]));
          for (const dispatchedTaskId of dispatchedTaskIds) {
            const task = latestByTask.get(dispatchedTaskId);
            if (!task) {
              continue;
            }
            const canMarkDispatched =
              task.state === "READY" ||
              (loopState.force && (task.state === "DISPATCHED" || task.state === "IN_PROGRESS"));
            if (!canMarkDispatched) {
              continue;
            }
            addWorkflowTaskTransition(latestRuntime, task, "DISPATCHED", "dispatched");
          }
          await dependencies.context.repositories.workflowRuns.writeRuntime(loopState.runId, latestRuntime);
          await dependencies.context.repositories.workflowRuns.patchRun(loopState.runId, {
            runtime: latestRuntime,
            autoDispatchRemaining: loopState.remaining,
            lastHeartbeatAt: new Date().toISOString()
          });
        });
      }
    }
  });
}

export function buildWorkflowDispatchResult(
  runId: string,
  state: WorkflowDispatchLoopState,
  dispatchResult: { results: WorkflowDispatchRow[]; dispatchedCount: number }
): WorkflowDispatchResult {
  return {
    runId,
    results: dispatchResult.results,
    dispatchedCount: dispatchResult.dispatchedCount,
    remainingBudget: state.remaining
  };
}
