import type { ProjectPaths, ProjectRecord, TaskActionResult, TaskActionType, TaskState } from "../../domain/models.js";

export type TaskActionErrorCode =
  | "TASK_ACTION_INVALID"
  | "TASK_BINDING_REQUIRED"
  | "TASK_BINDING_MISMATCH"
  | "TASK_ROUTE_DENIED"
  | "TASK_DEPENDENCY_CYCLE"
  | "TASK_DEPENDENCY_CROSS_ROOT"
  | "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN"
  | "TASK_NOT_RUNNABLE"
  | "TASK_RESULT_INVALID_TARGET"
  | "TASK_PROGRESS_REQUIRED"
  | "TASK_STATE_STALE"
  | "TASK_DEPENDENCY_NOT_READY"
  | "TASK_REPORT_NO_STATE_CHANGE"
  | "TASK_NOT_FOUND";

export class TaskActionError extends Error {
  constructor(
    message: string,
    public readonly code: TaskActionErrorCode,
    status?: number,
    public readonly details?: Record<string, unknown>,
    public readonly hint?: string
  ) {
    super(message);
    this.status = status ?? getDefaultStatusForCode(code);
  }

  public readonly status: number;
}

function getDefaultStatusForCode(code: TaskActionErrorCode): number {
  switch (code) {
    case "TASK_ACTION_INVALID":
    case "TASK_BINDING_REQUIRED":
    case "TASK_PROGRESS_REQUIRED":
      return 400;
    case "TASK_RESULT_INVALID_TARGET":
    case "TASK_ROUTE_DENIED":
      return 403;
    case "TASK_NOT_FOUND":
      return 404;
    case "TASK_REPORT_NO_STATE_CHANGE":
    case "TASK_STATE_STALE":
    case "TASK_DEPENDENCY_NOT_READY":
    case "TASK_BINDING_MISMATCH":
    case "TASK_DEPENDENCY_CYCLE":
    case "TASK_DEPENDENCY_CROSS_ROOT":
    case "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN":
    case "TASK_NOT_RUNNABLE":
    default:
      return 409;
  }
}

export interface TaskReportRejectedResult {
  task_id: string;
  reason_code: "TASK_RESULT_INVALID_TARGET" | "TASK_STATE_STALE";
  reason: string;
  current_state?: TaskState;
  reported_target_state?: TaskState;
}

export interface TaskActionHandlerContext {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  body: Record<string, unknown>;
  actionType: TaskActionType;
  normalizedActionType?: string;
  actionInput: Record<string, unknown>;
  requestId: string;
  fromAgent: string;
  fromSessionId: string;
  fromSessionToken: string;
  toRole?: string;
  normalizedToRole?: string;
  toSessionId?: string;
  defaultTaskId?: string;
}

export interface TaskActionHandler {
  readonly actionTypes: TaskActionType[];
  handle(context: TaskActionHandlerContext): Promise<TaskActionResult>;
}
