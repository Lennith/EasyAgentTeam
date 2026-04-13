import { createProjectLockScope } from "../data/repository/project/lock-repository.js";
import { listAgents } from "../data/repository/catalog/agent-repository.js";
import { buildProjectRoutingSnapshot } from "./project-routing-snapshot-service.js";
import { handleTaskAction, TaskActionError } from "./task-action-service.js";
import { handleManagerMessageSend, ManagerMessageServiceError } from "./manager-message-service.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "./teamtool/types.js";
import { createMiniMaxTeamToolBridgeBase, TeamToolBridgeError } from "./minimax-teamtool-bridge-core.js";
import { buildTaskExistsNextAction } from "./teamtool-contract.js";

function resolveTaskActionNextAction(code: string): string | null {
  switch (code) {
    case "TASK_PROGRESS_REQUIRED":
      return "Update Agents/<role>/progress.md with concrete evidence and task_id, then retry once.";
    case "TASK_RESULT_INVALID_TARGET":
      return "Report only tasks owned by your role or created by your role.";
    case "TASK_BINDING_REQUIRED":
      return "Fill required task binding fields (task_id, owner_role, or discuss target).";
    case "TASK_ROUTE_DENIED":
      return "Choose an allowed route target or request route-table update.";
    case "TASK_EXISTS":
      return buildTaskExistsNextAction();
    case "TASK_REPORT_NO_STATE_CHANGE":
      return "Do not resend identical report. Add new progress and evidence.";
    case "TASK_STATE_STALE":
      return "Task is already in a newer terminal state. Keep same-state report or continue downstream.";
    case "TASK_DEPENDENCY_NOT_READY":
      return "Wait until dependency tasks are DONE/CANCELED, then retry IN_PROGRESS/DONE report.";
    case "TASK_ACTION_INVALID":
      return "Fix payload schema for selected action_type and retry once.";
    default:
      return null;
  }
}

export { TeamToolBridgeError } from "./minimax-teamtool-bridge-core.js";

export function createMiniMaxTeamToolBridge(context: TeamToolExecutionContext): TeamToolBridge {
  const lockScope = createProjectLockScope(context.dataRoot, context.project.projectId, context.project.workspacePath);
  return createMiniMaxTeamToolBridgeBase({
    lockScope,
    defaultSessionId: context.sessionId,
    async taskAction(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
      try {
        const result = await handleTaskAction(context.dataRoot, context.project, context.paths, requestBody);
        return result as unknown as Record<string, unknown>;
      } catch (error) {
        if (error instanceof TaskActionError) {
          throw new TeamToolBridgeError(
            error.status,
            error.code,
            error.message,
            error.nextAction ?? resolveTaskActionNextAction(error.code),
            error.details
          );
        }
        throw new TeamToolBridgeError(
          500,
          "TASK_ACTION_BRIDGE_ERROR",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
    async sendMessage(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
      try {
        const result = await handleManagerMessageSend(context.dataRoot, context.project, context.paths, requestBody);
        return result as unknown as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ManagerMessageServiceError) {
          throw new TeamToolBridgeError(
            error.status,
            error.code,
            error.message,
            error.nextAction ?? null,
            error.details ?? error.replacement
          );
        }
        throw new TeamToolBridgeError(
          500,
          "MANAGER_MESSAGE_BRIDGE_ERROR",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
    async getRouteTargets(fromAgent: string): Promise<Record<string, unknown>> {
      const registry = await listAgents(context.dataRoot);
      const snapshot = buildProjectRoutingSnapshot(
        context.project,
        fromAgent,
        registry.map((item) => item.agentId)
      );
      return snapshot as unknown as Record<string, unknown>;
    }
  });
}
