import { spawn } from "node:child_process";
import type { EventRecord, ProjectPaths, ProjectRecord, SessionRecord } from "../../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import {
  cancelMiniMaxRunner,
  isMiniMaxRunnerActive,
  unregisterMiniMaxCompletionCallback,
  unregisterMiniMaxWakeUpCallback
} from "../../minimax-runner.js";
import { readPayloadString } from "../shared/dispatch-engine.js";

const DEFAULT_SESSION_TERMINATION_TIMEOUT_MS = 1000;

export type SessionProcessTerminationResultCode =
  | "killed"
  | "not_found"
  | "access_denied"
  | "failed"
  | "skipped_no_pid";

export interface SessionProcessTerminationResult {
  attempted: boolean;
  pid: number | null;
  result: SessionProcessTerminationResultCode;
  message: string;
}

export function readPidFromEventPayload(payload: Record<string, unknown>): number | null {
  const raw = payload.pid;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

export function findLatestOpenRun(sessionEvents: EventRecord[]): { event: EventRecord; runId: string } | null {
  const started = new Map<string, EventRecord>();
  for (const event of sessionEvents) {
    const payload = event.payload as Record<string, unknown>;
    const runId = readPayloadString(payload, "runId");
    if (!runId) {
      continue;
    }
    if (event.eventType === "CODEX_RUN_STARTED" || event.eventType === "MINIMAX_RUN_STARTED") {
      started.set(runId, event);
      continue;
    }
    if (event.eventType === "CODEX_RUN_FINISHED" || event.eventType === "MINIMAX_RUN_FINISHED") {
      started.delete(runId);
    }
  }
  if (started.size === 0) {
    return null;
  }
  const latest = [...started.entries()].sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt))[0];
  return { runId: latest[0], event: latest[1] };
}

export function hasDispatchClosedEvent(sessionEvents: EventRecord[], dispatchId: string): boolean {
  const normalized = dispatchId.trim();
  if (!normalized) {
    return false;
  }
  return sessionEvents.some((event) => {
    if (event.eventType !== "ORCHESTRATOR_DISPATCH_FINISHED" && event.eventType !== "ORCHESTRATOR_DISPATCH_FAILED") {
      return false;
    }
    const payload = event.payload as Record<string, unknown>;
    return readPayloadString(payload, "dispatchId") === normalized;
  });
}

export function findLatestDispatchStartedById(
  sessionEvents: EventRecord[],
  dispatchId: string
): { event: EventRecord; dispatchId: string } | null {
  const normalized = dispatchId.trim();
  if (!normalized) {
    return null;
  }
  const candidates = sessionEvents.filter((event) => {
    if (event.eventType !== "ORCHESTRATOR_DISPATCH_STARTED") {
      return false;
    }
    const payload = event.payload as Record<string, unknown>;
    return readPayloadString(payload, "dispatchId") === normalized;
  });
  if (candidates.length === 0) {
    return null;
  }
  const latest = candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return { dispatchId: normalized, event: latest };
}

export function findLatestDispatchStarted(
  sessionEvents: EventRecord[]
): { event: EventRecord; dispatchId: string } | null {
  const started = sessionEvents
    .filter((event) => event.eventType === "ORCHESTRATOR_DISPATCH_STARTED")
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      const dispatchId = readPayloadString(payload, "dispatchId");
      return dispatchId ? { event, dispatchId } : null;
    })
    .filter((item): item is { event: EventRecord; dispatchId: string } => item !== null);
  if (started.length === 0) {
    return null;
  }
  return started.sort((a, b) => Date.parse(b.event.createdAt) - Date.parse(a.event.createdAt))[0];
}

function getSessionTerminationTimeoutMs(): number {
  const raw = Number(process.env.SESSION_PROCESS_TERMINATION_TIMEOUT_MS ?? DEFAULT_SESSION_TERMINATION_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SESSION_TERMINATION_TIMEOUT_MS;
  }
  return Math.floor(raw);
}

export async function terminateProcessByPid(pid: number): Promise<SessionProcessTerminationResult> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "pipe"
        });
      } catch (error) {
        const known = error as NodeJS.ErrnoException;
        resolve({
          attempted: true,
          pid,
          result: known.code === "EPERM" ? "access_denied" : "failed",
          message: known.message || "taskkill spawn failed"
        });
        return;
      }
      const timeoutMs = getSessionTerminationTimeoutMs();
      const timeoutTimer = setTimeout(() => {
        proc.kill();
        resolve({
          attempted: true,
          pid,
          result: "failed",
          message: `taskkill timeout after ${timeoutMs}ms`
        });
      }, timeoutMs);
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("error", (error) => {
        clearTimeout(timeoutTimer);
        resolve({ attempted: true, pid, result: "failed", message: error.message });
      });
      proc.on("close", (code) => {
        clearTimeout(timeoutTimer);
        if (code === 0) {
          resolve({ attempted: true, pid, result: "killed", message: "process tree terminated" });
          return;
        }
        const output = `${stdout}\n${stderr}`.toLowerCase();
        if (output.includes("not found") || output.includes("no running instance")) {
          resolve({ attempted: true, pid, result: "not_found", message: "process not found" });
          return;
        }
        if (output.includes("access is denied")) {
          resolve({ attempted: true, pid, result: "access_denied", message: "access denied when terminating process" });
          return;
        }
        resolve({
          attempted: true,
          pid,
          result: "failed",
          message: (stderr || stdout || "taskkill failed").trim() || "taskkill failed"
        });
      });
    });
  }

  return new Promise((resolve) => {
    try {
      process.kill(pid, "SIGKILL");
      resolve({ attempted: true, pid, result: "killed", message: "process terminated" });
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ESRCH") {
        resolve({ attempted: true, pid, result: "not_found", message: "process not found" });
        return;
      }
      if (known.code === "EPERM") {
        resolve({ attempted: true, pid, result: "access_denied", message: "access denied when terminating process" });
        return;
      }
      resolve({ attempted: true, pid, result: "failed", message: known.message || "failed to terminate process" });
    }
  });
}

function resolveProjectTerminationPid(session: SessionRecord, sessionEvents: EventRecord[]): number | null {
  if (typeof session.agentPid === "number" && Number.isFinite(session.agentPid) && session.agentPid > 0) {
    return Math.floor(session.agentPid);
  }
  const openRun = findLatestOpenRun(sessionEvents);
  if (!openRun) {
    return null;
  }
  const payload = (openRun.event.payload ?? {}) as Record<string, unknown>;
  return readPidFromEventPayload(payload);
}

export async function terminateProjectSessionProcessInternal(
  repositories: Pick<ProjectRepositoryBundle, "events">,
  project: ProjectRecord,
  paths: ProjectPaths,
  session: SessionRecord,
  reason: string
): Promise<SessionProcessTerminationResult> {
  if (session.lastRunId) {
    unregisterMiniMaxCompletionCallback(session.lastRunId);
    unregisterMiniMaxWakeUpCallback(session.lastRunId);
  }
  if (isMiniMaxRunnerActive(session.sessionId)) {
    const cancelled = cancelMiniMaxRunner(session.sessionId);
    await repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "SESSION_PROCESS_TERMINATION_ATTEMPTED",
      source: "manager",
      sessionId: session.sessionId,
      taskId: session.currentTaskId,
      payload: { reason, type: "minimax_cancel" }
    });
    if (cancelled) {
      await repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_PROCESS_TERMINATION_FINISHED",
        source: "manager",
        sessionId: session.sessionId,
        taskId: session.currentTaskId,
        payload: {
          reason,
          type: "minimax_cancel",
          result: "cancelled",
          message: "MiniMax runner cancelled"
        }
      });
      return {
        attempted: true,
        pid: null,
        result: "killed",
        message: "MiniMax runner cancelled"
      };
    }
  }

  const sessionEvents = (await repositories.events.listEvents(paths)).filter(
    (item) => item.sessionId === session.sessionId
  );
  const pid = resolveProjectTerminationPid(session, sessionEvents);
  if (!pid) {
    return {
      attempted: false,
      pid: null,
      result: "skipped_no_pid",
      message: "no process pid available for this session"
    };
  }

  await repositories.events.appendEvent(paths, {
    projectId: project.projectId,
    eventType: "SESSION_PROCESS_TERMINATION_ATTEMPTED",
    source: "manager",
    sessionId: session.sessionId,
    taskId: session.currentTaskId,
    payload: { reason, pid }
  });

  const outcome = await terminateProcessByPid(pid);
  await repositories.events.appendEvent(paths, {
    projectId: project.projectId,
    eventType:
      outcome.result === "killed" || outcome.result === "not_found"
        ? "SESSION_PROCESS_TERMINATION_FINISHED"
        : "SESSION_PROCESS_TERMINATION_FAILED",
    source: "manager",
    sessionId: session.sessionId,
    taskId: session.currentTaskId,
    payload: {
      reason,
      pid,
      result: outcome.result,
      message: outcome.message
    }
  });
  return outcome;
}
