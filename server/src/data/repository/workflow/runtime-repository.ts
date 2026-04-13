import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProviderId } from "@autodev/agent-library";
import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunEventRecord,
  WorkflowRoleRemindersState,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowSessionsState,
  WorkflowSessionStatus
} from "../../../domain/models.js";
import { ensureDirectory, ensureFile } from "../../internal/persistence/file-utils.js";
import {
  appendJsonlLine,
  readJsonFile,
  readJsonlLines,
  writeJsonFile,
  writeJsonlLines
} from "../../internal/persistence/store/store-runtime.js";
import { traceWorkflowPerfSpan } from "../../../services/workflow-perf-trace.js";

interface WorkflowRunRuntimePaths {
  runRootDir: string;
  tasksFile: string;
  sessionsFile: string;
  eventsFile: string;
  roleRemindersFile: string;
  inboxDir: string;
  outboxDir: string;
  auditDir: string;
}

class WorkflowRunWriteMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const waitFor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await waitFor.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const runWriteMutexes = new Map<string, WorkflowRunWriteMutex>();

function getRunWriteMutex(runId: string): WorkflowRunWriteMutex {
  const existing = runWriteMutexes.get(runId);
  if (existing) {
    return existing;
  }
  const created = new WorkflowRunWriteMutex();
  runWriteMutexes.set(runId, created);
  return created;
}

async function withRunWriteLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  return getRunWriteMutex(runId).runExclusive(operation);
}

function assertRunId(runIdRaw: string): string {
  const runId = runIdRaw.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error("run_id must match /^[a-zA-Z0-9_-]+$/");
  }
  return runId;
}

export function getWorkflowRunRuntimePaths(dataRoot: string, runIdRaw: string): WorkflowRunRuntimePaths {
  const runId = assertRunId(runIdRaw);
  const runRootDir = path.join(dataRoot, "workflows", "runs", runId);
  return {
    runRootDir,
    tasksFile: path.join(runRootDir, "tasks.json"),
    sessionsFile: path.join(runRootDir, "sessions.json"),
    eventsFile: path.join(runRootDir, "events.jsonl"),
    roleRemindersFile: path.join(runRootDir, "role_reminders.json"),
    inboxDir: path.join(runRootDir, "inbox"),
    outboxDir: path.join(runRootDir, "outbox"),
    auditDir: path.join(runRootDir, "audit")
  };
}

function defaultTaskRuntimeState(): WorkflowRunRuntimeState {
  const now = new Date().toISOString();
  return {
    initializedAt: now,
    updatedAt: now,
    transitionSeq: 0,
    tasks: []
  };
}

function defaultSessionsState(runId: string): WorkflowSessionsState {
  return {
    schemaVersion: "1.0",
    runId,
    updatedAt: new Date().toISOString(),
    sessions: []
  };
}

function defaultRoleRemindersState(runId: string): WorkflowRoleRemindersState {
  return {
    schemaVersion: "1.0",
    runId,
    updatedAt: new Date().toISOString(),
    roleReminders: []
  };
}

export async function ensureWorkflowRunRuntime(
  dataRoot: string,
  runIdRaw: string,
  initialRuntime?: WorkflowRunRuntimeState
): Promise<WorkflowRunRuntimePaths> {
  const runId = assertRunId(runIdRaw);
  return await traceWorkflowPerfSpan(
    {
      dataRoot,
      runId,
      scope: "repo",
      name: "workflowRuns.ensureRuntime"
    },
    async () => {
      const paths = getWorkflowRunRuntimePaths(dataRoot, runId);
      await ensureDirectory(paths.runRootDir);
      await ensureDirectory(paths.inboxDir);
      await ensureDirectory(paths.outboxDir);
      await ensureDirectory(paths.auditDir);
      await ensureFile(paths.tasksFile, `${JSON.stringify(initialRuntime ?? defaultTaskRuntimeState(), null, 2)}\n`);
      await ensureFile(paths.sessionsFile, `${JSON.stringify(defaultSessionsState(runId), null, 2)}\n`);
      await ensureFile(paths.eventsFile, "");
      await ensureFile(paths.roleRemindersFile, `${JSON.stringify(defaultRoleRemindersState(runId), null, 2)}\n`);
      return paths;
    }
  );
}

export async function readWorkflowRunTaskRuntimeState(
  dataRoot: string,
  runIdRaw: string
): Promise<WorkflowRunRuntimeState> {
  const runId = assertRunId(runIdRaw);
  return await traceWorkflowPerfSpan(
    {
      dataRoot,
      runId,
      scope: "repo",
      name: "workflowRuns.readRuntime"
    },
    async () => {
      const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
      return await withRunWriteLock(runId, async () => readJsonFile(paths.tasksFile, defaultTaskRuntimeState()));
    }
  );
}

export async function writeWorkflowRunTaskRuntimeState(
  dataRoot: string,
  runIdRaw: string,
  runtime: WorkflowRunRuntimeState
): Promise<void> {
  const runId = assertRunId(runIdRaw);
  const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
  await withRunWriteLock(runId, async () => {
    await writeJsonFile(paths.tasksFile, runtime);
  });
}

function normalizeSessionStatus(statusRaw: string | undefined): WorkflowSessionStatus {
  const status = (statusRaw ?? "idle").toLowerCase();
  if (status === "running" || status === "idle" || status === "blocked" || status === "dismissed") {
    return status;
  }
  return "idle";
}

export async function listWorkflowSessions(
  dataRoot: string,
  runIdRaw: string
): Promise<WorkflowSessionRecord[]> {
  const runId = assertRunId(runIdRaw);
  return await traceWorkflowPerfSpan(
    {
      dataRoot,
      runId,
      scope: "repo",
      name: "sessions.listSessions"
    },
    async () => {
      const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
      return await withRunWriteLock(runId, async () => {
        const state = await readJsonFile(paths.sessionsFile, defaultSessionsState(runId));
        return [...state.sessions];
      });
    }
  );
}

export async function getWorkflowSession(
  dataRoot: string,
  runIdRaw: string,
  sessionIdRaw: string
): Promise<WorkflowSessionRecord | null> {
  const runId = assertRunId(runIdRaw);
  const sessionId = sessionIdRaw.trim();
  const sessions = await listWorkflowSessions(dataRoot, runId);
  return sessions.find((item) => item.sessionId === sessionId) ?? null;
}

export async function upsertWorkflowSession(
  dataRoot: string,
  runIdRaw: string,
  input: {
    sessionId: string;
    role: string;
    status?: string;
    provider?: ProviderId;
    providerSessionId?: string;
    timeoutStreak?: number;
    errorStreak?: number;
    lastFailureAt?: string;
    lastFailureKind?: "timeout" | "error";
    cooldownUntil?: string;
    lastRunId?: string;
  }
): Promise<{ session: WorkflowSessionRecord; created: boolean }> {
  const runId = assertRunId(runIdRaw);
  const sessionId = input.sessionId.trim();
  const role = input.role.trim();
  if (!sessionId || !/^[a-zA-Z0-9._:-]+$/.test(sessionId)) {
    throw new Error("session_id is invalid");
  }
  if (!role) {
    throw new Error("role is required");
  }
  return await traceWorkflowPerfSpan(
    {
      dataRoot,
      runId,
      scope: "repo",
      name: "sessions.upsertSession"
    },
    async () => {
      const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
      return await withRunWriteLock(runId, async () => {
        const state = await readJsonFile(paths.sessionsFile, defaultSessionsState(runId));
        const now = new Date().toISOString();
        const idx = state.sessions.findIndex((item) => item.sessionId === sessionId);
        if (idx >= 0) {
          const updated: WorkflowSessionRecord = {
            ...state.sessions[idx],
            role,
            status: normalizeSessionStatus(input.status ?? state.sessions[idx].status),
            provider: input.provider ?? state.sessions[idx].provider,
            providerSessionId: input.providerSessionId?.trim() || state.sessions[idx].providerSessionId,
            timeoutStreak: input.timeoutStreak ?? state.sessions[idx].timeoutStreak,
            errorStreak: input.errorStreak ?? state.sessions[idx].errorStreak,
            lastFailureAt: input.lastFailureAt?.trim() || state.sessions[idx].lastFailureAt,
            lastFailureKind: input.lastFailureKind ?? state.sessions[idx].lastFailureKind,
            cooldownUntil: input.cooldownUntil?.trim() || state.sessions[idx].cooldownUntil,
            lastRunId: input.lastRunId?.trim() || state.sessions[idx].lastRunId,
            updatedAt: now,
            lastActiveAt: now
          };
          state.sessions[idx] = updated;
          state.updatedAt = now;
          await writeJsonFile(paths.sessionsFile, state);
          return { session: updated, created: false };
        }
        const created: WorkflowSessionRecord = {
          schemaVersion: "1.0",
          sessionId,
          runId,
          role,
          status: normalizeSessionStatus(input.status),
          provider: input.provider ?? "minimax",
          providerSessionId: input.providerSessionId?.trim() || undefined,
          timeoutStreak: input.timeoutStreak,
          errorStreak: input.errorStreak,
          lastFailureAt: input.lastFailureAt?.trim() || undefined,
          lastFailureKind: input.lastFailureKind,
          cooldownUntil: input.cooldownUntil?.trim() || undefined,
          lastRunId: input.lastRunId?.trim() || undefined,
          createdAt: now,
          updatedAt: now,
          lastActiveAt: now
        };
        state.sessions.push(created);
        state.updatedAt = now;
        await writeJsonFile(paths.sessionsFile, state);
        return { session: created, created: true };
      });
    }
  );
}

export async function touchWorkflowSession(
  dataRoot: string,
  runIdRaw: string,
  sessionIdRaw: string,
  patch: {
    status?: string;
    role?: string;
    currentTaskId?: string | null;
    lastInboxMessageId?: string | null;
    lastDispatchedAt?: string | null;
    lastDispatchId?: string | null;
    lastDispatchedMessageId?: string | null;
    providerSessionId?: string | null;
    provider?: ProviderId | null;
    timeoutStreak?: number | null;
    errorStreak?: number | null;
    lastFailureAt?: string | null;
    lastFailureKind?: "timeout" | "error" | null;
    cooldownUntil?: string | null;
    lastRunId?: string | null;
    agentPid?: number | null;
  } = {}
): Promise<WorkflowSessionRecord> {
  const runId = assertRunId(runIdRaw);
  const sessionId = sessionIdRaw.trim();
  return await traceWorkflowPerfSpan(
    {
      dataRoot,
      runId,
      scope: "repo",
      name: "sessions.touchSession"
    },
    async () => {
      const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
      return await withRunWriteLock(runId, async () => {
        const state = await readJsonFile(paths.sessionsFile, defaultSessionsState(runId));
        const idx = state.sessions.findIndex((item) => item.sessionId === sessionId);
        if (idx < 0) {
          throw new Error(`session '${sessionId}' not found`);
        }
        const now = new Date().toISOString();
        const existing = state.sessions[idx];
        const updated: WorkflowSessionRecord = {
          ...existing,
          role: patch.role?.trim() || existing.role,
          status: patch.status ? normalizeSessionStatus(patch.status) : existing.status,
          currentTaskId:
            patch.currentTaskId === null ? undefined : patch.currentTaskId?.trim() || existing.currentTaskId,
          lastInboxMessageId:
            patch.lastInboxMessageId === null
              ? undefined
              : patch.lastInboxMessageId?.trim() || existing.lastInboxMessageId,
          lastDispatchedAt:
            patch.lastDispatchedAt === null ? undefined : patch.lastDispatchedAt?.trim() || existing.lastDispatchedAt,
          lastDispatchId:
            patch.lastDispatchId === null ? undefined : patch.lastDispatchId?.trim() || existing.lastDispatchId,
          lastDispatchedMessageId:
            patch.lastDispatchedMessageId === null
              ? undefined
              : patch.lastDispatchedMessageId?.trim() || existing.lastDispatchedMessageId,
          providerSessionId:
            patch.providerSessionId === null
              ? undefined
              : patch.providerSessionId?.trim() || existing.providerSessionId,
          provider: patch.provider === null ? existing.provider : patch.provider || existing.provider,
          timeoutStreak: patch.timeoutStreak === null ? undefined : patch.timeoutStreak ?? existing.timeoutStreak,
          errorStreak: patch.errorStreak === null ? undefined : patch.errorStreak ?? existing.errorStreak,
          lastFailureAt:
            patch.lastFailureAt === null ? undefined : patch.lastFailureAt?.trim() || existing.lastFailureAt,
          lastFailureKind: patch.lastFailureKind === null ? undefined : patch.lastFailureKind ?? existing.lastFailureKind,
          cooldownUntil:
            patch.cooldownUntil === null ? undefined : patch.cooldownUntil?.trim() || existing.cooldownUntil,
          lastRunId: patch.lastRunId === null ? undefined : patch.lastRunId?.trim() || existing.lastRunId,
          agentPid: patch.agentPid === null ? undefined : patch.agentPid ?? existing.agentPid,
          updatedAt: now,
          lastActiveAt: now
        };
        state.sessions[idx] = updated;
        state.updatedAt = now;
        await writeJsonFile(paths.sessionsFile, state);
        return updated;
      });
    }
  );
}

export async function appendWorkflowRunEvent(
  dataRoot: string,
  runIdRaw: string,
  input: {
    eventType: string;
    source: "manager" | "agent" | "system" | "dashboard";
    payload: Record<string, unknown>;
    sessionId?: string;
    taskId?: string;
  }
): Promise<WorkflowRunEventRecord> {
  const runId = assertRunId(runIdRaw);
  const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
  const event: WorkflowRunEventRecord = {
    schemaVersion: "1.0",
    eventId: randomUUID(),
    runId,
    eventType: input.eventType,
    source: input.source,
    createdAt: new Date().toISOString(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    payload: input.payload
  };
  await appendJsonlLine(paths.eventsFile, event);
  return event;
}

export async function listWorkflowRunEvents(
  dataRoot: string,
  runIdRaw: string,
  since?: string
): Promise<WorkflowRunEventRecord[]> {
  const runId = assertRunId(runIdRaw);
  const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
  const all = await readJsonlLines<WorkflowRunEventRecord>(paths.eventsFile);
  if (!since) {
    return all;
  }
  const sinceTs = Date.parse(since);
  if (Number.isNaN(sinceTs)) {
    return all;
  }
  return all.filter((event) => Date.parse(event.createdAt) > sinceTs);
}

export async function appendWorkflowInboxMessage(
  dataRoot: string,
  runIdRaw: string,
  targetRole: string,
  message: WorkflowManagerToAgentMessage
): Promise<string> {
  const runId = assertRunId(runIdRaw);
  const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
  const file = path.join(paths.inboxDir, `${targetRole}.jsonl`);
  await appendJsonlLine(file, message);
  return file;
}

export async function listWorkflowInboxMessages(
  dataRoot: string,
  runIdRaw: string,
  targetRole: string,
  limit?: number
): Promise<WorkflowManagerToAgentMessage[]> {
  const runId = assertRunId(runIdRaw);
  const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
  const file = path.join(paths.inboxDir, `${targetRole}.jsonl`);
  const all = await readJsonlLines<WorkflowManagerToAgentMessage>(file);
  if (!limit || limit <= 0 || all.length <= limit) {
    return all;
  }
  return all.slice(all.length - limit);
}

export async function removeWorkflowInboxMessages(
  dataRoot: string,
  runIdRaw: string,
  targetRole: string,
  messageIds: string[]
): Promise<number> {
  const runId = assertRunId(runIdRaw);
  if (messageIds.length === 0) {
    return 0;
  }
  const paths = await ensureWorkflowRunRuntime(dataRoot, runId);
  const file = path.join(paths.inboxDir, `${targetRole}.jsonl`);
  const all = await readJsonlLines<WorkflowManagerToAgentMessage>(file);
  const idSet = new Set(messageIds);
  const remaining = all.filter((item) => !idSet.has(item.envelope.message_id));
  if (remaining.length === all.length) {
    return 0;
  }
  await writeJsonlLines(file, remaining);
  return all.length - remaining.length;
}
