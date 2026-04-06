import type express from "express";
import { WorkflowRuntimeError } from "../services/orchestrator/index.js";
import { TeamToolsTemplateError } from "../services/project-agent-script-service.js";
import { logger } from "../utils/logger.js";
import { sendApiError } from "./shared/http.js";

type NamedError = Error & {
  code?: string;
  details?: Record<string, unknown> | null;
};

function asNamedError(error: unknown, expectedName: string): NamedError | null {
  if (!(error instanceof Error)) {
    return null;
  }
  return error.constructor?.name === expectedName ? (error as NamedError) : null;
}

export function translateApiError(error: unknown, req: express.Request, res: express.Response): boolean {
  const projectStoreError = asNamedError(error, "ProjectStoreError");
  if (projectStoreError) {
    if (projectStoreError.code === "PROJECT_EXISTS") {
      sendApiError(
        res,
        409,
        "PROJECT_EXISTS",
        projectStoreError.message,
        "Use another project_id or delete existing project."
      );
      return true;
    }
    if (projectStoreError.code === "PROJECT_NOT_FOUND") {
      sendApiError(res, 404, "PROJECT_NOT_FOUND", projectStoreError.message, "Check project id.");
      return true;
    }
    if (projectStoreError.code === "INVALID_PROJECT_ID") {
      sendApiError(
        res,
        400,
        "INVALID_PROJECT_ID",
        projectStoreError.message,
        "Use lowercase letters, numbers, '-' or '_'."
      );
      return true;
    }
    if (projectStoreError.code === "INVALID_ROUTE_TABLE") {
      sendApiError(res, 400, "INVALID_ROUTE_TABLE", projectStoreError.message);
      return true;
    }
    if (projectStoreError.code === "PROJECT_RUNTIME_BUSY") {
      sendApiError(
        res,
        409,
        "PROJECT_RUNTIME_BUSY",
        projectStoreError.message,
        "Retry delete after active project runtime stops."
      );
      return true;
    }
  }

  const workflowStoreError = asNamedError(error, "WorkflowStoreError");
  if (workflowStoreError) {
    if (workflowStoreError.code === "TEMPLATE_EXISTS") {
      sendApiError(res, 409, "WORKFLOW_TEMPLATE_EXISTS", workflowStoreError.message);
      return true;
    }
    if (workflowStoreError.code === "RUN_EXISTS") {
      sendApiError(res, 409, "WORKFLOW_RUN_EXISTS", workflowStoreError.message);
      return true;
    }
    if (workflowStoreError.code === "TEMPLATE_NOT_FOUND") {
      sendApiError(res, 404, "WORKFLOW_TEMPLATE_NOT_FOUND", workflowStoreError.message);
      return true;
    }
    if (workflowStoreError.code === "RUN_NOT_FOUND") {
      sendApiError(res, 404, "WORKFLOW_RUN_NOT_FOUND", workflowStoreError.message);
      return true;
    }
    if (workflowStoreError.code === "INVALID_TEMPLATE_ID" || workflowStoreError.code === "INVALID_RUN_ID") {
      sendApiError(res, 400, workflowStoreError.code, workflowStoreError.message);
      return true;
    }
    sendApiError(res, 400, "WORKFLOW_STORE_ERROR", workflowStoreError.message);
    return true;
  }

  if (error instanceof WorkflowRuntimeError) {
    sendApiError(
      res,
      error.status,
      error.code,
      error.message,
      error.hint,
      error.details ? { details: error.details } : undefined
    );
    return true;
  }

  const storageAccessError = asNamedError(error, "StorageAccessError");
  if (storageAccessError) {
    const details: Record<string, unknown> = {
      ...(storageAccessError.details ?? {})
    };
    const runIdFromParams = typeof req.params?.run_id === "string" ? req.params.run_id.trim() : "";
    const runIdFromPath = (req.originalUrl.match(/\/api\/workflow-runs\/([^/?]+)/)?.[1] ?? "").trim();
    const projectIdFromParams = typeof req.params?.id === "string" ? req.params.id.trim() : "";
    const projectIdFromPath = (req.originalUrl.match(/\/api\/projects\/([^/?]+)/)?.[1] ?? "").trim();
    const runId = runIdFromParams || runIdFromPath;
    const projectId = projectIdFromParams || projectIdFromPath;
    if (runId) {
      details.runId = runId;
    }
    if (projectId) {
      details.projectId = projectId;
    }
    logger.error(
      `[API] ${req.method} ${req.originalUrl} - storage unavailable: ${storageAccessError.message}, details=${JSON.stringify(details)}`
    );
    sendApiError(
      res,
      503,
      "STORAGE_TEMPORARILY_UNAVAILABLE",
      storageAccessError.message,
      "Retry later; persistence layer is temporarily unavailable.",
      { details }
    );
    return true;
  }

  const lockStoreError = asNamedError(error, "LockStoreError");
  if (lockStoreError) {
    sendApiError(res, 400, "LOCK_STORE_ERROR", lockStoreError.message);
    return true;
  }

  const taskboardStoreError = asNamedError(error, "TaskboardStoreError");
  if (taskboardStoreError) {
    if (taskboardStoreError.code === "TASK_EXISTS") {
      sendApiError(res, 409, "TASK_EXISTS", taskboardStoreError.message, "Use unique task_id.");
      return true;
    }
    if (taskboardStoreError.code === "TASK_NOT_FOUND") {
      sendApiError(res, 404, "TASK_NOT_FOUND", taskboardStoreError.message, "Check task_id.");
      return true;
    }
    if (
      taskboardStoreError.code === "TASK_DEPENDENCY_CYCLE" ||
      taskboardStoreError.code === "TASK_DEPENDENCY_CROSS_ROOT" ||
      taskboardStoreError.code === "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN"
    ) {
      sendApiError(res, 409, taskboardStoreError.code, taskboardStoreError.message, undefined, {
        details: taskboardStoreError.details ?? null
      });
      return true;
    }
    sendApiError(res, 400, "TASKBOARD_ERROR", taskboardStoreError.message, undefined, {
      details: taskboardStoreError.details ?? null
    });
    return true;
  }

  const sessionStoreError = asNamedError(error, "SessionStoreError");
  if (sessionStoreError) {
    if (sessionStoreError.code === "SESSION_NOT_FOUND") {
      sendApiError(res, 404, "SESSION_NOT_FOUND", sessionStoreError.message, "Create or resolve valid session_id.");
      return true;
    }
    sendApiError(res, 400, "SESSION_STORE_ERROR", sessionStoreError.message);
    return true;
  }

  const agentStoreError = asNamedError(error, "AgentStoreError");
  if (agentStoreError) {
    if (agentStoreError.code === "AGENT_EXISTS") {
      sendApiError(res, 409, "AGENT_EXISTS", agentStoreError.message);
      return true;
    }
    if (agentStoreError.code === "AGENT_NOT_FOUND") {
      sendApiError(res, 404, "AGENT_NOT_FOUND", agentStoreError.message);
      return true;
    }
    sendApiError(res, 400, "AGENT_STORE_ERROR", agentStoreError.message);
    return true;
  }

  const agentTemplateStoreError = asNamedError(error, "AgentTemplateStoreError");
  if (agentTemplateStoreError) {
    if (agentTemplateStoreError.code === "TEMPLATE_EXISTS") {
      sendApiError(res, 409, "TEMPLATE_EXISTS", agentTemplateStoreError.message);
      return true;
    }
    if (agentTemplateStoreError.code === "TEMPLATE_NOT_FOUND") {
      sendApiError(res, 404, "TEMPLATE_NOT_FOUND", agentTemplateStoreError.message);
      return true;
    }
    sendApiError(res, 400, "TEMPLATE_STORE_ERROR", agentTemplateStoreError.message);
    return true;
  }

  const skillStoreError = asNamedError(error, "SkillStoreError");
  if (skillStoreError) {
    if (skillStoreError.code === "SKILL_NOT_FOUND") {
      sendApiError(res, 404, "SKILL_NOT_FOUND", skillStoreError.message);
      return true;
    }
    if (skillStoreError.code === "SKILL_LIST_NOT_FOUND") {
      sendApiError(res, 404, "SKILL_LIST_NOT_FOUND", skillStoreError.message);
      return true;
    }
    if (skillStoreError.code === "SKILL_LIST_EXISTS") {
      sendApiError(res, 409, "SKILL_LIST_EXISTS", skillStoreError.message);
      return true;
    }
    if (skillStoreError.code === "INVALID_SKILL_REFERENCE") {
      sendApiError(res, 400, "INVALID_SKILL_REFERENCE", skillStoreError.message);
      return true;
    }
    sendApiError(res, 400, "SKILL_STORE_ERROR", skillStoreError.message);
    return true;
  }

  if (error instanceof TeamToolsTemplateError) {
    sendApiError(
      res,
      500,
      error.code,
      error.message,
      "Ensure repository root has TeamsTools/ template files or set AUTO_DEV_TEAMTOOLS_SOURCE."
    );
    return true;
  }

  if (error instanceof Error) {
    logger.error(
      `[API] ${req.method} ${req.originalUrl} - unhandled error: ${error.message}\n${error.stack ?? "(no stack)"}`
    );
  } else {
    logger.error(`[API] ${req.method} ${req.originalUrl} - unhandled non-error rejection: ${String(error)}`);
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  sendApiError(res, 500, "INTERNAL_SERVER_ERROR", message, "Inspect server logs for stack trace.");
  return true;
}
