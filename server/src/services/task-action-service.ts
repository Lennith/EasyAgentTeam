import { randomUUID } from "node:crypto";
import { ProjectTaskActionRequestSchema } from "@autodev/agent-library";
import type { ProjectPaths, ProjectRecord, TaskActionType } from "../domain/models.js";
import { appendEvent } from "../data/repository/project/event-repository.js";
import { getSession } from "../data/repository/project/session-repository.js";
import { TaskboardStoreError } from "../data/repository/project/taskboard-repository.js";
import {
  buildTaskActionRejectedNextAction,
  buildTaskActionAuditPayload,
  mapTaskboardStoreError,
  readDefaultTaskId,
  readString
} from "./task-actions/shared.js";
import { defaultTaskActionRegistry } from "./task-actions/registry.js";
import { TaskActionError } from "./task-actions/types.js";
import { runOrchestratorTaskActionPipeline } from "./orchestrator/shared/index.js";

const SUPPORTED_ACTION_TYPES: TaskActionType[] = [
  "TASK_CREATE",
  "TASK_UPDATE",
  "TASK_ASSIGN",
  "TASK_DISCUSS_REQUEST",
  "TASK_DISCUSS_REPLY",
  "TASK_DISCUSS_CLOSED",
  "TASK_REPORT"
];

function normalizeTaskActionType(value: string | undefined): TaskActionType | undefined {
  const normalized = value?.toUpperCase();
  if (!normalized) {
    return undefined;
  }
  return SUPPORTED_ACTION_TYPES.includes(normalized as TaskActionType) ? (normalized as TaskActionType) : undefined;
}

export { TaskActionError } from "./task-actions/types.js";

export async function handleTaskAction(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  body: Record<string, unknown>
) {
  const parsed = ProjectTaskActionRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new TaskActionError("task action payload is invalid", "TASK_ACTION_INVALID", 400);
  }
  const actionTypeRaw = parsed.data.actionType;
  const requestId = parsed.data.requestId ?? randomUUID();
  const fromAgent = parsed.data.fromAgent;
  const fromSessionToken = parsed.data.fromSessionId ?? "manager-system";
  const toRole = parsed.data.toRole;
  const toSessionId = parsed.data.toSessionId;
  const actionInput = parsed.data.actionInput;
  const defaultTaskId = readDefaultTaskId(actionInput);
  const actionType = normalizeTaskActionType(actionTypeRaw);
  const normalizedActionType = actionTypeRaw?.toUpperCase();
  const normalizedToRole = toRole ?? (actionType === "TASK_REPORT" ? "manager" : undefined);
  let fromSessionId = fromSessionToken;

  try {
    return await runOrchestratorTaskActionPipeline(
      {
        dataRoot,
        project,
        paths,
        body,
        actionType,
        normalizedActionType,
        actionInput,
        requestId,
        fromAgent,
        fromSessionToken,
        toRole,
        normalizedToRole,
        toSessionId,
        defaultTaskId
      },
      {
        parse: async (state) => state,
        authorize: async (state) => {
          const resolvedFromSession =
            state.fromSessionToken === "manager-system"
              ? null
              : await getSession(state.paths, state.project.projectId, state.fromSessionToken).catch(() => null);
          const resolvedFromSessionId = resolvedFromSession?.sessionId ?? state.fromSessionToken;
          fromSessionId = resolvedFromSessionId;
          return {
            ...state,
            fromSessionId: resolvedFromSessionId
          };
        },
        checkDependencyGate: async (state) => state,
        apply: async (state) => {
          await appendEvent(state.paths, {
            projectId: state.project.projectId,
            eventType: "TASK_ACTION_RECEIVED",
            source: "manager",
            sessionId: state.fromSessionId,
            taskId: state.defaultTaskId,
            payload: buildTaskActionAuditPayload(
              state.actionType ?? state.normalizedActionType ?? "UNKNOWN",
              state.requestId,
              state.fromAgent,
              state.normalizedToRole,
              state.toSessionId,
              state.actionInput
            )
          });
          if (!state.actionType) {
            throw new TaskActionError("action_type is invalid", "TASK_ACTION_INVALID", 400);
          }
          const result = await defaultTaskActionRegistry.handle({
            dataRoot: state.dataRoot,
            project: state.project,
            paths: state.paths,
            body: state.body,
            actionType: state.actionType,
            normalizedActionType: state.normalizedActionType,
            actionInput: state.actionInput,
            requestId: state.requestId,
            fromAgent: state.fromAgent,
            fromSessionId: state.fromSessionId,
            fromSessionToken: state.fromSessionToken,
            toRole: state.toRole,
            normalizedToRole: state.normalizedToRole,
            toSessionId: state.toSessionId,
            defaultTaskId: state.defaultTaskId
          });
          return {
            ...state,
            result
          };
        },
        convergeRuntime: async (state) => state,
        emit: async (state) => state.result
      }
    );
  } catch (error) {
    let normalizedError: unknown = error;
    if (error instanceof TaskboardStoreError) {
      const mapped = mapTaskboardStoreError(error);
      if (mapped) {
        normalizedError = mapped;
      }
    }
    if (normalizedError instanceof TaskActionError) {
      const nextAction = normalizedError.nextAction ?? buildTaskActionRejectedNextAction(normalizedError.code);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_ACTION_REJECTED",
        source: "manager",
        sessionId: fromSessionId,
        taskId: defaultTaskId,
        payload: {
          requestId,
          actionType: actionType ?? normalizedActionType ?? "UNKNOWN",
          fromAgent,
          toRole: normalizedToRole ?? null,
          toSessionId: toSessionId ?? null,
          error_code: normalizedError.code,
          reason: normalizedError.message,
          next_action: nextAction,
          details: normalizedError.details ?? null
        }
      });
    }
    throw normalizedError;
  }
}
