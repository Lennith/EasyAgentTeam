import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowTaskRuntimeRecord
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type { NormalizedDispatchSelectionResult, OrchestratorDispatchSelectionAdapter } from "../shared/contracts.js";
import type { OrchestratorSingleFlightGate } from "../shared/kernel/single-flight.js";
import {
  buildNormalizedDispatchSelectionResult,
  buildOrchestratorDuplicateTaskDispatchSkipResult,
  evaluateOrchestratorDispatchSessionAvailability
} from "../shared/index.js";
import { collectOrchestratorRoleSet, sortOrchestratorRoles } from "../shared/role-candidates.js";
import type { WorkflowDispatchRow } from "./workflow-dispatch-types.js";
import { resolveWorkflowDispatchRoleSelection } from "./workflow-dispatch-selection-task.js";

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
  selectedMessageIds: string[];
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

      const chosen = await resolveWorkflowDispatchRoleSelection({
        repositories: this.context.repositories,
        run: scope.run,
        runtimeTaskById,
        role: roleCandidate,
        taskFilter,
        force: input.force
      });
      if (!chosen) {
        continue;
      }

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
          ...buildNormalizedDispatchSelectionResult({
            role: roleCandidate,
            session,
            dispatchKind: chosen.dispatchKind,
            taskId: chosen.taskId,
            message: chosen.message,
            requestId: input.requestId
          }),
          selectedMessageIds: chosen.selectedMessageIds,
          runtimeTask: chosen.runtimeTask
        }
      };
    }

    return {
      status: "none",
      busyFound
    };
  }
}
