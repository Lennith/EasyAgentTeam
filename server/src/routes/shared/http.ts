import express from "express";
import { getBuiltInAgents } from "../../services/agent-prompt-service.js";
import type { ProviderId } from "@autodev/agent-library";
import type { WorkflowRunMode } from "../../domain/models.js";
import { buildRoleScopedSessionId } from "../../services/orchestrator/shared/orchestrator-identifiers.js";

export function readStringField(body: Record<string, unknown>, keys: string[], fallback?: string): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

export function readNullableStringPatch(body: Record<string, unknown>, keys: string[]): string | null | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      continue;
    }
    const value = body[key];
    if (value === null) {
      return null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return undefined;
  }
  return undefined;
}

export function parseInteger(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

export function parseBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  return fallback;
}

export function sanitizeSessionForApi<T extends { providerSessionId?: string }>(
  session: T
): Omit<T, "providerSessionId"> {
  const { providerSessionId: _ignored, ...rest } = session;
  return rest;
}

export function parseReminderMode(raw: unknown): "backoff" | "fixed_interval" | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "backoff" || normalized === "fixed_interval") {
    return normalized;
  }
  return undefined;
}

export function parseWorkflowRunMode(raw: unknown): WorkflowRunMode | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "none" || normalized === "loop" || normalized === "schedule") {
    return normalized;
  }
  return undefined;
}

export function parseScheduleExpression(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function readStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw
    .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
    .filter((item) => item.length > 0);
  return values.length > 0 ? values : undefined;
}

export function readStringMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([key, value]) => [key.trim(), typeof value === "string" ? value.trim() : String(value).trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

export function normalizeProviderId(raw: unknown, fallback: ProviderId = "minimax"): ProviderId {
  if (typeof raw !== "string") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "codex" || normalized === "trae" || normalized === "minimax") {
    return normalized;
  }
  return fallback;
}

export function readProviderIdField(
  body: Record<string, unknown>,
  key: string,
  fallback: ProviderId = "minimax"
): ProviderId {
  const value = body[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return normalizeProviderId(value, fallback);
  }
  return fallback;
}

export function readAgentModelConfigsField(
  raw: unknown
): Record<string, { provider_id: ProviderId; model: string; effort?: "low" | "medium" | "high" }> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const output: Record<string, { provider_id: ProviderId; model: string; effort?: "low" | "medium" | "high" }> = {};
  for (const [role, configRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!configRaw || typeof configRaw !== "object") {
      continue;
    }
    const config = configRaw as Record<string, unknown>;
    const model = readStringField(config, ["model"]);
    if (!model) {
      continue;
    }
    const effortRaw = readStringField(config, ["effort"]);
    const effort = effortRaw === "low" || effortRaw === "medium" || effortRaw === "high" ? effortRaw : undefined;
    output[role] = {
      provider_id: readProviderIdField(config, "provider_id", "minimax"),
      model,
      ...(effort ? { effort } : {})
    };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function readRouteTable(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const table: Record<string, string[]> = {};
  for (const [from, targetsRaw] of Object.entries(raw as Record<string, unknown>)) {
    const fromKey = from.trim();
    if (!fromKey) {
      continue;
    }
    table[fromKey] = readStringArray(targetsRaw) ?? [];
  }
  return Object.keys(table).length > 0 ? table : undefined;
}

export function readRouteDiscussRounds(raw: unknown): Record<string, Record<string, number>> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const output: Record<string, Record<string, number>> = {};
  for (const [from, inner] of Object.entries(raw as Record<string, unknown>)) {
    const fromKey = from.trim();
    if (!fromKey || !inner || typeof inner !== "object") {
      continue;
    }
    const values: Record<string, number> = {};
    for (const [to, roundsRaw] of Object.entries(inner as Record<string, unknown>)) {
      const toKey = to.trim();
      const rounds = parseInteger(roundsRaw);
      if (!toKey || rounds === undefined || rounds < 1) {
        continue;
      }
      values[toKey] = rounds;
    }
    if (Object.keys(values).length > 0) {
      output[fromKey] = values;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function readWorkflowTasks(raw: unknown):
  | Array<{
      taskId: string;
      title: string;
      ownerRole: string;
      parentTaskId?: string;
      dependencies?: string[];
      writeSet?: string[];
      acceptance?: string[];
      artifacts?: string[];
    }>
  | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        taskId: readStringField(row, ["task_id", "taskId"]) ?? "",
        title: readStringField(row, ["title"]) ?? "",
        ownerRole: readStringField(row, ["owner_role", "ownerRole"]) ?? "",
        parentTaskId: readStringField(row, ["parent_task_id", "parentTaskId"]),
        dependencies: readStringArray(row.dependencies),
        writeSet: readStringArray(row.write_set ?? row.writeSet),
        acceptance: readStringArray(row.acceptance),
        artifacts: readStringArray(row.artifacts)
      };
    });
}

export function readWorkflowTaskActionRequest(raw: unknown): {
  actionType: "TASK_REPORT" | "TASK_CREATE" | "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED";
  fromAgent?: string;
  fromSessionId?: string;
  toRole?: string;
  toSessionId?: string;
  taskId?: string;
  content?: string;
  task?: {
    taskId: string;
    title: string;
    ownerRole: string;
    parentTaskId?: string;
    dependencies?: string[];
    acceptance?: string[];
    artifacts?: string[];
  };
  discuss?: {
    threadId?: string;
    requestId?: string;
  };
  results?: Array<{
    taskId: string;
    outcome: "IN_PROGRESS" | "BLOCKED_DEP" | "MAY_BE_DONE" | "DONE" | "CANCELED";
    summary?: string;
    blockers?: string[];
  }>;
} | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const actionTypeRaw = readStringField(body, ["action_type", "actionType"]);
  if (
    actionTypeRaw !== "TASK_REPORT" &&
    actionTypeRaw !== "TASK_CREATE" &&
    actionTypeRaw !== "TASK_DISCUSS_REQUEST" &&
    actionTypeRaw !== "TASK_DISCUSS_REPLY" &&
    actionTypeRaw !== "TASK_DISCUSS_CLOSED"
  ) {
    return null;
  }
  const fromAgent = readStringField(body, ["from_agent", "fromAgent"]);
  const fromSessionId = readStringField(body, ["from_session_id", "fromSessionId"]);
  const toRole = readStringField(body, ["to_role", "toRole"]);
  const toSessionId = readStringField(body, ["to_session_id", "toSessionId"]);
  const taskId = readStringField(body, ["task_id", "taskId"]);
  const content = readStringField(body, ["content"]);
  const discussRaw =
    typeof body.discuss === "object" && body.discuss !== null ? (body.discuss as Record<string, unknown>) : null;
  const discuss = discussRaw
    ? {
        threadId: readStringField(discussRaw, ["thread_id", "threadId"]),
        requestId: readStringField(discussRaw, ["request_id", "requestId"])
      }
    : undefined;
  const taskRaw = typeof body.task === "object" && body.task !== null ? (body.task as Record<string, unknown>) : null;
  const task = taskRaw
    ? {
        taskId: readStringField(taskRaw, ["task_id", "taskId"]) ?? "",
        title: readStringField(taskRaw, ["title"]) ?? "",
        ownerRole: readStringField(taskRaw, ["owner_role", "ownerRole"]) ?? "",
        parentTaskId: readStringField(taskRaw, ["parent_task_id", "parentTaskId"]),
        dependencies: readStringArray(taskRaw.dependencies),
        acceptance: readStringArray(taskRaw.acceptance),
        artifacts: readStringArray(taskRaw.artifacts)
      }
    : undefined;
  const results = Array.isArray(body.results)
    ? body.results
        .filter((item) => item && typeof item === "object")
        .map((item) => {
          const row = item as Record<string, unknown>;
          const taskId = readStringField(row, ["task_id", "taskId"]) ?? "";
          const outcomeRaw = readStringField(row, ["outcome"]) ?? "";
          const outcome =
            outcomeRaw === "IN_PROGRESS" ||
            outcomeRaw === "BLOCKED_DEP" ||
            outcomeRaw === "MAY_BE_DONE" ||
            outcomeRaw === "DONE" ||
            outcomeRaw === "CANCELED"
              ? outcomeRaw
              : null;
          return {
            taskId,
            outcome,
            summary: readStringField(row, ["summary"]),
            blockers: readStringArray(row.blockers)
          };
        })
        .filter((item) => item.taskId.length > 0 && item.outcome !== null)
        .map((item) => ({
          taskId: item.taskId,
          outcome: item.outcome as "IN_PROGRESS" | "BLOCKED_DEP" | "MAY_BE_DONE" | "DONE" | "CANCELED",
          summary: item.summary,
          blockers: item.blockers
        }))
    : undefined;
  if (actionTypeRaw === "TASK_REPORT" && (!results || results.length === 0)) return null;
  if (actionTypeRaw === "TASK_CREATE" && (!task || !task.taskId || !task.title || !task.ownerRole)) return null;
  return {
    actionType: actionTypeRaw,
    fromAgent,
    fromSessionId,
    toRole,
    toSessionId,
    taskId,
    content,
    task,
    discuss,
    results
  };
}

export function applyTemplateVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_all, key: string) => variables[key] ?? "");
}

export function buildFallbackRolePrompt(role: string): string {
  return [
    `Role: ${role}`,
    "",
    "Objective:",
    "- Execute assigned workflow tasks and deliver file-based outputs in TeamWorkSpace.",
    "- Report progress and blockers through TASK_REPORT with concrete evidence."
  ].join("\n");
}

export function buildRolePromptMapForRoles(
  roles: string[],
  agents: Array<{ agentId: string; prompt: string }>
): Map<string, string> {
  const promptMap = new Map<string, string>();
  for (const agent of agents) {
    const prompt = agent.prompt?.trim();
    if (prompt) {
      promptMap.set(agent.agentId, prompt);
    }
  }
  for (const builtIn of getBuiltInAgents()) {
    const prompt = builtIn.prompt?.trim();
    if (prompt && !promptMap.has(builtIn.agentId)) {
      promptMap.set(builtIn.agentId, prompt);
    }
  }
  for (const role of roles) {
    if (!promptMap.has(role)) {
      promptMap.set(role, buildFallbackRolePrompt(role));
    }
  }
  return promptMap;
}

export function buildSessionId(role: string): string {
  return buildRoleScopedSessionId(role);
}

export function isWorkflowRuntimeTerminal(run: { runtime?: { tasks?: Array<{ state?: string }> } }): boolean {
  const tasks = run.runtime?.tasks ?? [];
  if (tasks.length === 0) {
    return false;
  }
  return tasks.every((task) => task.state === "DONE" || task.state === "CANCELED");
}

export function withDerivedWorkflowRunStatus<
  T extends { status: string; runtime?: { tasks?: Array<{ state?: string }> } }
>(run: T): T {
  if (run.status === "stopped" && isWorkflowRuntimeTerminal(run)) {
    return {
      ...run,
      status: "finished"
    };
  }
  return run;
}

export function retiredEndpoint(res: express.Response, replacement: string): void {
  res.status(410).json({
    code: "ENDPOINT_RETIRED",
    error: "endpoint retired",
    replacement
  });
}

export function sendApiError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  hint?: string,
  extra?: Record<string, unknown>
): void {
  const details =
    extra && typeof extra.details === "object" && extra.details
      ? (extra.details as Record<string, unknown>)
      : undefined;
  res.status(status).json({
    error_code: code,
    error: { code, message, ...(details ? { details } : {}) },
    message,
    hint: hint ?? null,
    next_action: hint ?? null,
    ...(extra ?? {})
  });
}

export function resolveTaskActionNextAction(code: string): string | null {
  switch (code) {
    case "TASK_PROGRESS_REQUIRED":
      return "Update Agents/<role>/progress.md with concrete evidence and reported task_id, then resend once.";
    case "TASK_RESULT_INVALID_TARGET":
      return "Report only tasks owned by your role or created by your role.";
    case "TASK_BINDING_REQUIRED":
      return "Fill required task binding fields (task_id, owner_role, or discuss target).";
    case "TASK_ROUTE_DENIED":
      return "Choose an allowed route target or request route-table update.";
    case "TASK_REPORT_NO_STATE_CHANGE":
      return "Do not resend identical report. Add new progress or report unresolved tasks.";
    case "TASK_STATE_STALE":
      return "Task state is already newer than this transition. Keep same-state report or continue with downstream tasks.";
    case "TASK_DEPENDENCY_NOT_READY":
      return "Wait for dependency tasks to reach DONE/CANCELED before reporting IN_PROGRESS/DONE.";
    case "TASK_ACTION_INVALID":
      return "Fix payload schema for selected action_type. For TASK_REPORT, send results[] with outcome in IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED.";
    default:
      return null;
  }
}
