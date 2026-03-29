import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState
} from "../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import { extractTaskIdFromMessage, sortMessagesByTime } from "../orchestrator-dispatch-core.js";
import type { NormalizedDispatchSelectionResult, OrchestratorDispatchSelectionAdapter } from "./shared/contracts.js";
import type { OrchestratorSingleFlightGate } from "./kernel/single-flight.js";
import {
  buildOrchestratorDuplicateTaskDispatchSkipResult,
  evaluateOrchestratorDispatchSessionAvailability
} from "./shared/dispatch-selection-support.js";
import { resolveOrchestratorDispatchCandidate } from "./shared/dispatch-selection-candidate.js";
import { collectOrchestratorRoleSet, sortOrchestratorRoles } from "./shared/role-candidates.js";

type WorkflowDispatchRow = {
  role: string;
  sessionId: string | null;
  taskId: string | null;
  dispatchKind?: "task" | "message" | null;
  messageId?: string;
  requestId?: string;
  outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target" | "already_dispatched";
  reason?: string;
};

export interface WorkflowDispatchSelectionScope {
  run: WorkflowRunRecord;
  runtime: WorkflowRunRuntimeState;
  sessions: WorkflowSessionRecord[];
}

export interface WorkflowDispatchSelectionInput {
  role?: string;
  taskId?: string;
  force: boolean;
  onlyIdle: boolean;
  requestId: string;
  remainingBudget: number;
}

export interface WorkflowDispatchSelection extends NormalizedDispatchSelectionResult<
  WorkflowSessionRecord,
  WorkflowManagerToAgentMessage
> {
  dispatchKind: "task" | "message";
  runtimeTask: WorkflowTaskRuntimeRecord | null;
}

export type WorkflowDispatchSelectionResult =
  | {
      status: "selected";
      selection: WorkflowDispatchSelection;
    }
  | {
      status: "none";
      busyFound: boolean;
    }
  | {
      status: "skipped";
      result: WorkflowDispatchRow;
    };

export interface WorkflowDispatchSelectionAdapterContext {
  repositories: WorkflowRepositoryBundle;
  inFlightDispatchSessionKeys: OrchestratorSingleFlightGate;
  buildRunSessionKey(runId: string, sessionId: string): string;
  resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason?: string
  ): Promise<WorkflowSessionRecord | null>;
}

export class WorkflowDispatchSelectionAdapter implements OrchestratorDispatchSelectionAdapter<
  WorkflowDispatchSelectionScope,
  WorkflowDispatchSelectionInput,
  WorkflowDispatchSelectionResult
> {
  constructor(private readonly context: WorkflowDispatchSelectionAdapterContext) {}

  async select(
    scope: WorkflowDispatchSelectionScope,
    input: WorkflowDispatchSelectionInput
  ): Promise<WorkflowDispatchSelectionResult> {
    const roleFilter = input.role?.trim();
    const taskFilter = input.taskId?.trim();
    const runtimeTaskById = new Map(scope.runtime.tasks.map((task) => [task.taskId, task]));
    const roleSet = collectOrchestratorRoleSet({
      explicitRole: roleFilter,
      sessionRoles: scope.sessions.map((session) => (session.status !== "dismissed" ? session.role : null)),
      taskOwnerRoles: scope.run.tasks.map((task) => task.ownerRole),
      mappedRoles: Object.keys(scope.run.roleSessionMap ?? {})
    });
    let busyFound = false;

    for (const roleCandidate of sortOrchestratorRoles(roleSet)) {
      const session = await this.context.resolveAuthoritativeSession(
        scope.run.runId,
        roleCandidate,
        scope.sessions,
        scope.run,
        "dispatch"
      );
      if (!session) {
        continue;
      }
      const sessionKey = this.context.buildRunSessionKey(scope.run.runId, session.sessionId);
      const availability = evaluateOrchestratorDispatchSessionAvailability({
        sessionStatus: session.status,
        onlyIdle: input.onlyIdle,
        force: input.force,
        cooldownUntil: session.cooldownUntil,
        hasInFlightDispatch: this.context.inFlightDispatchSessionKeys.has(sessionKey),
        treatRunningAsBusy: true
      });
      if (!availability.available) {
        busyFound = true;
        continue;
      }

      const messages = sortMessagesByTime(
        await this.context.repositories.inbox.listInboxMessages(scope.run.runId, roleCandidate)
      ).filter((message) => !taskFilter || (extractTaskIdFromMessage(message) ?? "") === taskFilter);

      const roleTasks = scope.run.tasks
        .filter((task) => task.ownerRole === roleCandidate)
        .filter((task) => !taskFilter || task.taskId === taskFilter)
        .reduce<
          Array<{
            taskId: string;
            state: WorkflowTaskState;
            createdAt: string;
            parentTaskId?: string;
            priority?: number;
          }>
        >((accumulator, task) => {
          const runtimeTask = runtimeTaskById.get(task.taskId);
          if (!runtimeTask) {
            return accumulator;
          }
          accumulator.push({
            taskId: task.taskId,
            state: runtimeTask.state,
            createdAt: runtimeTask.lastTransitionAt ?? scope.run.createdAt,
            parentTaskId: task.parentTaskId,
            priority: 0
          });
          return accumulator;
        }, []);
      const roleTaskById = new Map(roleTasks.map((task) => [task.taskId, task]));
      const runnableRoleTasks = roleTasks.filter(
        (task) =>
          task.state === "READY" ||
          (input.force &&
            taskFilter === task.taskId &&
            (task.state === "DISPATCHED" || task.state === "IN_PROGRESS" || task.state === "MAY_BE_DONE"))
      );
      const candidate = resolveOrchestratorDispatchCandidate({
        messages,
        runnableTasks: runnableRoleTasks,
        allTasks: roleTasks,
        force: input.force,
        resolveTaskById: (taskId) => roleTaskById.get(taskId) ?? null
      });
      if (!candidate) {
        continue;
      }
      const selectedRuntimeTask = candidate.taskId ? (runtimeTaskById.get(candidate.taskId) ?? null) : null;
      if (candidate.dispatchKind === "task" && !selectedRuntimeTask) {
        continue;
      }
      if (candidate.dispatchKind === "message" && !candidate.firstMessage) {
        continue;
      }
      const chosen: {
        taskId: string | null;
        dispatchKind: "task" | "message";
        message: WorkflowManagerToAgentMessage | null;
        runtimeTask: WorkflowTaskRuntimeRecord | null;
      } = {
        taskId: candidate.taskId,
        dispatchKind: candidate.dispatchKind,
        message: candidate.firstMessage,
        runtimeTask: selectedRuntimeTask
      };

      if (
        !input.force &&
        (scope.run.autoDispatchEnabled ?? true) &&
        chosen.dispatchKind === "task" &&
        input.remainingBudget <= 0
      ) {
        return {
          status: "skipped",
          result: {
            role: roleCandidate,
            sessionId: session.sessionId,
            taskId: chosen.taskId,
            outcome: "invalid_target",
            reason: "auto dispatch budget exhausted"
          }
        };
      }

      if (!input.force && chosen.dispatchKind === "task" && chosen.taskId) {
        const chosenTaskId = chosen.taskId;
        const duplicateSkipResult = await buildOrchestratorDuplicateTaskDispatchSkipResult<WorkflowDispatchRow>({
          taskId: chosenTaskId,
          sessionId: session.sessionId,
          listEvents: async () => await this.context.repositories.events.listEvents(scope.run.runId),
          onDuplicateDetected: async () => {
            await this.context.repositories.events.appendEvent(scope.run.runId, {
              eventType: "ORCHESTRATOR_DISPATCH_SKIPPED",
              source: "system",
              sessionId: session.sessionId,
              taskId: chosenTaskId,
              payload: {
                requestId: input.requestId,
                dispatchKind: chosen.dispatchKind,
                dispatchSkipReason: "duplicate_open_dispatch"
              }
            });
          },
          buildSkippedResult: () => ({
            role: roleCandidate,
            sessionId: session.sessionId,
            taskId: chosenTaskId,
            dispatchKind: chosen.dispatchKind,
            requestId: input.requestId,
            outcome: "already_dispatched",
            reason: "duplicate_open_dispatch"
          })
        });
        if (duplicateSkipResult) {
          return {
            status: "skipped",
            result: duplicateSkipResult
          };
        }
      }

      return {
        status: "selected",
        selection: {
          role: roleCandidate,
          session,
          dispatchKind: chosen.dispatchKind,
          taskId: chosen.taskId,
          message: chosen.message,
          messageId: chosen.message?.envelope.message_id ?? null,
          requestId: input.requestId,
          runtimeTask: chosen.runtimeTask,
          skipReason: undefined,
          terminalOutcome: undefined
        }
      };
    }

    return {
      status: "none",
      busyFound
    };
  }
}
