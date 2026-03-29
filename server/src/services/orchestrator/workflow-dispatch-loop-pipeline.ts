import { randomUUID } from "node:crypto";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowSessionRecord } from "../../domain/models.js";
import type { OrchestratorSingleFlightGate } from "./kernel/single-flight.js";
import type { WorkflowDispatchLaunchAdapter } from "./workflow-dispatch-launch-adapter.js";
import type {
  WorkflowDispatchSelection,
  WorkflowDispatchSelectionAdapter
} from "./workflow-dispatch-selection-adapter.js";
import { addWorkflowTaskTransition } from "./runtime/workflow-runtime-kernel.js";
import { runOrchestratorDispatchTemplate } from "./shared/index.js";

export interface WorkflowDispatchRow {
  role: string;
  sessionId: string | null;
  taskId: string | null;
  dispatchKind?: "task" | "message" | null;
  messageId?: string;
  requestId?: string;
  outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target" | "already_dispatched";
  reason?: string;
}

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

interface WorkflowDispatchLoopPipelineContext {
  repositories: WorkflowRepositoryBundle;
  maxConcurrentDispatches: number;
  inFlightDispatchSessionKeys: OrchestratorSingleFlightGate;
  buildRunSessionKey(runId: string, sessionId: string): string;
  readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  selectionAdapter: WorkflowDispatchSelectionAdapter;
  launchAdapter: WorkflowDispatchLaunchAdapter;
  onLaunchError(error: unknown): void;
}

export class WorkflowDispatchLoopPipeline {
  constructor(private readonly context: WorkflowDispatchLoopPipelineContext) {}

  async run(
    state: WorkflowDispatchLoopState,
    maxDispatches: number
  ): Promise<{
    results: WorkflowDispatchRow[];
    dispatchedCount: number;
  }> {
    return await runOrchestratorDispatchTemplate<
      WorkflowDispatchLoopState,
      WorkflowDispatchSelection,
      WorkflowDispatchPrepared,
      WorkflowDispatchRow
    >({
      state,
      gate: this.context.inFlightDispatchSessionKeys,
      maxDispatches,
      preflight: {
        beforeLoop: async (loopState) => {
          if (loopState.run.status !== "running") {
            await this.context.repositories.events.appendEvent(loopState.runId, {
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
            this.context.inFlightDispatchSessionKeys.size >= this.context.maxConcurrentDispatches
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
          const messageId = selection.messageId ?? undefined;
          if (selection.dispatchKind === "task" && selection.runtimeTask) {
            addWorkflowTaskTransition(loopState.runtime, selection.runtimeTask, "DISPATCHED", "dispatched");
          }

          await this.context.repositories.sessions
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
          if (selection.dispatchKind === "message" && selection.message) {
            await this.context.repositories.inbox.removeInboxMessages(loopState.runId, selection.role, [
              selection.message.envelope.message_id
            ]);
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
          await this.context.selectionAdapter.select(
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
          this.context.buildRunSessionKey(loopState.runId, selection.session.sessionId),
        createSingleFlightBusyResult: (selection, loopState) => ({
          role: selection.role,
          sessionId: selection.session.sessionId,
          taskId: selection.taskId,
          dispatchKind: selection.dispatchKind,
          requestId: loopState.requestId,
          outcome: "session_busy" as const,
          reason: "session already dispatching"
        }),
        dispatch: async (selection, prepared, loopState) => {
          void this.context.launchAdapter
            .launch({
              run: loopState.run,
              session: selection.session,
              role: selection.role,
              dispatchKind: selection.dispatchKind,
              taskId: selection.taskId,
              message: selection.message,
              requestId: loopState.requestId,
              messageId: prepared.messageId,
              dispatchId: prepared.dispatchId
            })
            .catch((error) => {
              this.context.onLaunchError(error);
            });

          return {
            role: selection.role,
            sessionId: selection.session.sessionId,
            taskId: selection.taskId,
            dispatchKind: selection.dispatchKind,
            messageId: prepared.messageId,
            requestId: loopState.requestId,
            outcome: "dispatched" as const
          };
        },
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

          await this.context.repositories.runInUnitOfWork({ run: loopState.run }, async () => {
            const freshRun = await this.context.loadRunOrThrow(loopState.runId);
            const latestRuntime = await this.context.readConvergedRuntime(freshRun);
            const latestByTask = new Map(latestRuntime.tasks.map((item) => [item.taskId, item]));
            for (const dispatchedTaskId of dispatchedTaskIds) {
              const task = latestByTask.get(dispatchedTaskId);
              if (!task) {
                continue;
              }
              const canMarkDispatched =
                task.state === "READY" ||
                (loopState.force &&
                  (task.state === "DISPATCHED" || task.state === "IN_PROGRESS" || task.state === "MAY_BE_DONE"));
              if (!canMarkDispatched) {
                continue;
              }
              addWorkflowTaskTransition(latestRuntime, task, "DISPATCHED", "dispatched");
            }
            await this.context.repositories.workflowRuns.writeRuntime(loopState.runId, latestRuntime);
            await this.context.repositories.workflowRuns.patchRun(loopState.runId, {
              runtime: latestRuntime,
              autoDispatchRemaining: loopState.remaining,
              lastHeartbeatAt: new Date().toISOString()
            });
          });
        }
      }
    });
  }
}
