import type express from "express";
import { ProjectStoreError } from "../data/project-store.js";
import { WorkflowStoreError } from "../data/workflow-store.js";
import { LockStoreError } from "../data/lock-store.js";
import { TaskboardStoreError } from "../data/taskboard-store.js";
import { SessionStoreError } from "../data/session-store.js";
import { AgentStoreError } from "../data/agent-store.js";
import { AgentTemplateStoreError } from "../data/agent-template-store.js";
import { SkillStoreError } from "../data/skill-store.js";
import { WorkflowRuntimeError } from "../services/orchestrator/index.js";
import { TeamToolsTemplateError } from "../services/project-agent-script-service.js";
import { logger } from "../utils/logger.js";
import { sendApiError } from "./shared/http.js";

export function translateApiError(error: unknown, req: express.Request, res: express.Response): boolean {
  if (error instanceof ProjectStoreError) {
    if (error.code === "PROJECT_EXISTS") {
      sendApiError(res, 409, "PROJECT_EXISTS", error.message, "Use another project_id or delete existing project.");
      return true;
    }
    if (error.code === "PROJECT_NOT_FOUND") {
      sendApiError(res, 404, "PROJECT_NOT_FOUND", error.message, "Check project id.");
      return true;
    }
    if (error.code === "INVALID_PROJECT_ID") {
      sendApiError(res, 400, "INVALID_PROJECT_ID", error.message, "Use lowercase letters, numbers, '-' or '_'.");
      return true;
    }
    if (error.code === "INVALID_ROUTE_TABLE") {
      sendApiError(res, 400, "INVALID_ROUTE_TABLE", error.message);
      return true;
    }
  }
  if (error instanceof WorkflowStoreError) {
    if (error.code === "TEMPLATE_EXISTS") {
      sendApiError(res, 409, "WORKFLOW_TEMPLATE_EXISTS", error.message);
      return true;
    }
    if (error.code === "RUN_EXISTS") {
      sendApiError(res, 409, "WORKFLOW_RUN_EXISTS", error.message);
      return true;
    }
    if (error.code === "TEMPLATE_NOT_FOUND") {
      sendApiError(res, 404, "WORKFLOW_TEMPLATE_NOT_FOUND", error.message);
      return true;
    }
    if (error.code === "RUN_NOT_FOUND") {
      sendApiError(res, 404, "WORKFLOW_RUN_NOT_FOUND", error.message);
      return true;
    }
    if (error.code === "INVALID_TEMPLATE_ID" || error.code === "INVALID_RUN_ID") {
      sendApiError(res, 400, error.code, error.message);
      return true;
    }
    sendApiError(res, 400, "WORKFLOW_STORE_ERROR", error.message);
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
  if (error instanceof LockStoreError) {
    sendApiError(res, 400, "LOCK_STORE_ERROR", error.message);
    return true;
  }
  if (error instanceof TaskboardStoreError) {
    if (error.code === "TASK_EXISTS") {
      sendApiError(res, 409, "TASK_EXISTS", error.message, "Use unique task_id.");
      return true;
    }
    if (error.code === "TASK_NOT_FOUND") {
      sendApiError(res, 404, "TASK_NOT_FOUND", error.message, "Check task_id.");
      return true;
    }
    if (
      error.code === "TASK_DEPENDENCY_CYCLE" ||
      error.code === "TASK_DEPENDENCY_CROSS_ROOT" ||
      error.code === "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN"
    ) {
      sendApiError(res, 409, error.code, error.message, undefined, { details: error.details ?? null });
      return true;
    }
    sendApiError(res, 400, "TASKBOARD_ERROR", error.message, undefined, { details: error.details ?? null });
    return true;
  }
  if (error instanceof SessionStoreError) {
    if (error.code === "SESSION_NOT_FOUND") {
      sendApiError(res, 404, "SESSION_NOT_FOUND", error.message, "Create or resolve valid session_id.");
      return true;
    }
    sendApiError(res, 400, "SESSION_STORE_ERROR", error.message);
    return true;
  }
  if (error instanceof AgentStoreError) {
    if (error.code === "AGENT_EXISTS") {
      sendApiError(res, 409, "AGENT_EXISTS", error.message);
      return true;
    }
    if (error.code === "AGENT_NOT_FOUND") {
      sendApiError(res, 404, "AGENT_NOT_FOUND", error.message);
      return true;
    }
    sendApiError(res, 400, "AGENT_STORE_ERROR", error.message);
    return true;
  }
  if (error instanceof AgentTemplateStoreError) {
    if (error.code === "TEMPLATE_EXISTS") {
      sendApiError(res, 409, "TEMPLATE_EXISTS", error.message);
      return true;
    }
    if (error.code === "TEMPLATE_NOT_FOUND") {
      sendApiError(res, 404, "TEMPLATE_NOT_FOUND", error.message);
      return true;
    }
    sendApiError(res, 400, "TEMPLATE_STORE_ERROR", error.message);
    return true;
  }
  if (error instanceof SkillStoreError) {
    if (error.code === "SKILL_NOT_FOUND") {
      sendApiError(res, 404, "SKILL_NOT_FOUND", error.message);
      return true;
    }
    if (error.code === "SKILL_LIST_NOT_FOUND") {
      sendApiError(res, 404, "SKILL_LIST_NOT_FOUND", error.message);
      return true;
    }
    if (error.code === "SKILL_LIST_EXISTS") {
      sendApiError(res, 409, "SKILL_LIST_EXISTS", error.message);
      return true;
    }
    if (error.code === "INVALID_SKILL_REFERENCE") {
      sendApiError(res, 400, "INVALID_SKILL_REFERENCE", error.message);
      return true;
    }
    sendApiError(res, 400, "SKILL_STORE_ERROR", error.message);
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
