import path from "node:path";
import { appendJsonlLine } from "../utils/file-utils.js";

type WorkflowPerfTraceScope = "route" | "repo" | "service" | "view";

interface WorkflowPerfTraceInput {
  dataRoot: string;
  runId: string;
  scope: WorkflowPerfTraceScope;
  name: string;
  details?: Record<string, unknown>;
}

interface WorkflowPerfTraceRecord extends WorkflowPerfTraceInput {
  at: string;
  schemaVersion: "1.0";
  elapsedMs: number;
  ok: boolean;
  error?: string;
}

function normalizeEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function getPerfTraceFilePath(dataRoot: string, runId: string): string {
  return path.join(dataRoot, "workflows", "runs", runId, "audit", "perf_trace.jsonl");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isWorkflowPerfTraceEnabled(): boolean {
  return normalizeEnvFlag(process.env.WORKFLOW_PERF_TRACE);
}

export async function recordWorkflowPerfSpan(
  input: WorkflowPerfTraceInput & {
    elapsedMs: number;
    ok?: boolean;
    error?: unknown;
  }
): Promise<void> {
  if (!isWorkflowPerfTraceEnabled()) {
    return;
  }
  const runId = input.runId.trim();
  if (!runId) {
    return;
  }

  const record: WorkflowPerfTraceRecord = {
    schemaVersion: "1.0",
    at: new Date().toISOString(),
    dataRoot: input.dataRoot,
    runId,
    scope: input.scope,
    name: input.name,
    details: input.details,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs * 100) / 100),
    ok: input.ok !== false
  };
  if (input.error !== undefined) {
    record.error = toErrorMessage(input.error);
  }

  const { dataRoot: _dataRoot, ...payload } = record;
  await appendJsonlLine(getPerfTraceFilePath(input.dataRoot, runId), payload);
}

export async function traceWorkflowPerfSpan<T>(input: WorkflowPerfTraceInput, operation: () => Promise<T>): Promise<T> {
  if (!isWorkflowPerfTraceEnabled()) {
    return await operation();
  }

  const startedAt = Date.now();
  try {
    const result = await operation();
    await recordWorkflowPerfSpan({
      ...input,
      elapsedMs: Date.now() - startedAt,
      ok: true
    });
    return result;
  } catch (error) {
    await recordWorkflowPerfSpan({
      ...input,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      error
    });
    throw error;
  }
}
