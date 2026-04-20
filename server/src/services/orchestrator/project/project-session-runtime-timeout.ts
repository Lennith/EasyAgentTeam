import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import type { ProjectPaths, ProjectRecord, SessionRecord, TaskRecord } from "../../../domain/models.js";
import { markRunnerTimeout } from "../../session-lifecycle-authority.js";
import { findLatestOpenDispatch, readPayloadString } from "../shared/dispatch-engine.js";
import { parseIsoMs } from "../shared/session-manager.js";
import { hasOrchestratorSessionHeartbeatTimedOut } from "../shared/session-manager.js";
import {
  findLatestDispatchStarted,
  findLatestDispatchStartedById,
  findLatestOpenRun,
  hasDispatchClosedEvent
} from "./project-session-runtime-termination.js";
export interface ProjectSessionTimeoutDependencies {
  dataRoot: string;
  repositories: ProjectRepositoryBundle;
  sessionRunningTimeoutMs: number;
  terminateSessionProcess(
    project: ProjectRecord,
    paths: ProjectPaths,
    session: SessionRecord,
    reason: string
  ): Promise<unknown>;
}

const TERMINAL_PROTECTION_TASK_STATES = new Set(["DONE", "BLOCKED_DEP"]);
const TERMINAL_REPORT_TOOL_NAMES = new Set(["task_report_done", "task_report_block"]);
const MAX_TERMINAL_REPORT_PROTECTION_MS = 15_000;

function resolveSyntheticRunFinishedEventType(
  provider: string | null | undefined
): "CODEX_RUN_FINISHED" | "MINIMAX_RUN_FINISHED" {
  return provider === "codex" ? "CODEX_RUN_FINISHED" : "MINIMAX_RUN_FINISHED";
}

function resolveTerminalProtectionWindowMs(timeoutMs: number): number {
  return Math.max(250, Math.min(MAX_TERMINAL_REPORT_PROTECTION_MS, Math.floor(timeoutMs / 2)));
}

function findTaskById(tasks: TaskRecord[], taskId: string | undefined): TaskRecord | undefined {
  if (!taskId) {
    return undefined;
  }
  return tasks.find((task) => task.taskId === taskId);
}

function resolveRecentTerminalReportEvidence(input: {
  sessionId: string;
  taskId: string | undefined;
  taskState: string | undefined;
  sessionEvents: Array<{ eventType: string; sessionId?: string; taskId?: string; createdAt: string; payload: unknown }>;
  protectionWindowMs: number;
  nowMs: number;
}): { reason: "recent_terminal_report"; eventType: string; eventAt: string } | null {
  if (!input.taskId || !input.taskState || !TERMINAL_PROTECTION_TASK_STATES.has(input.taskState)) {
    return null;
  }

  const recentEvents = [...input.sessionEvents]
    .filter((event) => event.sessionId === input.sessionId && event.taskId === input.taskId)
    .sort((a, b) => parseIsoMs(b.createdAt) - parseIsoMs(a.createdAt));

  for (const event of recentEvents) {
    const ageMs = input.nowMs - parseIsoMs(event.createdAt);
    if (ageMs < 0 || ageMs > input.protectionWindowMs) {
      continue;
    }
    if (event.eventType === "TASK_REPORT_APPLIED") {
      return { reason: "recent_terminal_report", eventType: event.eventType, eventAt: event.createdAt };
    }
    if (event.eventType !== "TEAM_TOOL_SUCCEEDED") {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const toolName = typeof payload.tool === "string" ? payload.tool : "";
    if (TERMINAL_REPORT_TOOL_NAMES.has(toolName)) {
      return { reason: "recent_terminal_report", eventType: event.eventType, eventAt: event.createdAt };
    }
  }

  return null;
}

async function revalidateTimedOutProjectSession(input: {
  dependencies: ProjectSessionTimeoutDependencies;
  project: ProjectRecord;
  paths: ProjectPaths;
  session: SessionRecord;
  nowMs: number;
}): Promise<
  | { skip: false; session: SessionRecord }
  | {
      skip: true;
      session: SessionRecord;
      reason: "heartbeat_refreshed" | "recent_terminal_report";
      matchedEventType?: string;
      matchedEventAt?: string;
    }
> {
  const latestSession =
    (await input.dependencies.repositories.sessions.listSessions(input.paths, input.project.projectId)).find(
      (item) => item.sessionId === input.session.sessionId
    ) ?? input.session;

  if (latestSession.status !== "running") {
    return { skip: true, session: latestSession, reason: "heartbeat_refreshed" };
  }

  if (
    !hasOrchestratorSessionHeartbeatTimedOut({
      lastActiveAt: latestSession.lastActiveAt,
      updatedAt: latestSession.updatedAt,
      createdAt: latestSession.createdAt,
      timeoutMs: input.dependencies.sessionRunningTimeoutMs,
      nowMs: input.nowMs
    })
  ) {
    return { skip: true, session: latestSession, reason: "heartbeat_refreshed" };
  }

  const protectionWindowMs = resolveTerminalProtectionWindowMs(input.dependencies.sessionRunningTimeoutMs);
  const sessionEvents = (await input.dependencies.repositories.events.listEvents(input.paths)).filter(
    (item) => item.sessionId === latestSession.sessionId
  );
  const currentTask = findTaskById(
    await input.dependencies.repositories.taskboard.listTasks(input.paths, input.project.projectId),
    latestSession.currentTaskId
  );
  const recentTerminalEvidence = resolveRecentTerminalReportEvidence({
    sessionId: latestSession.sessionId,
    taskId: latestSession.currentTaskId,
    taskState: currentTask?.state,
    sessionEvents,
    protectionWindowMs,
    nowMs: input.nowMs
  });
  if (!recentTerminalEvidence) {
    return { skip: false, session: latestSession };
  }

  const refreshedSession = await input.dependencies.repositories.sessions.touchSession(
    input.paths,
    input.project.projectId,
    latestSession.sessionId,
    { lastActiveAt: recentTerminalEvidence.eventAt }
  );
  return {
    skip: true,
    session: refreshedSession,
    reason: recentTerminalEvidence.reason,
    matchedEventType: recentTerminalEvidence.eventType,
    matchedEventAt: recentTerminalEvidence.eventAt
  };
}

export async function markProjectTimedOutSessions(
  dependencies: ProjectSessionTimeoutDependencies,
  project: ProjectRecord,
  paths: ProjectPaths
): Promise<void> {
  const sessions = await dependencies.repositories.sessions.listSessions(paths, project.projectId);
  const nowMs = Date.now();
  for (const session of sessions) {
    if (session.status !== "running") {
      continue;
    }
    let activeSession = session;
    if (
      !hasOrchestratorSessionHeartbeatTimedOut({
        lastActiveAt: activeSession.lastActiveAt,
        updatedAt: activeSession.updatedAt,
        createdAt: activeSession.createdAt,
        timeoutMs: dependencies.sessionRunningTimeoutMs,
        nowMs
      })
    ) {
      continue;
    }

    const revalidated = await revalidateTimedOutProjectSession({
      dependencies,
      project,
      paths,
      session: activeSession,
      nowMs
    });
    if (revalidated.skip) {
      await dependencies.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_HEARTBEAT_TIMEOUT_SKIPPED",
        source: "manager",
        sessionId: revalidated.session.sessionId,
        taskId: revalidated.session.currentTaskId ?? activeSession.currentTaskId,
        payload: {
          previousStatus: "running",
          timeoutMs: dependencies.sessionRunningTimeoutMs,
          lastActiveAt: activeSession.lastActiveAt,
          revalidatedLastActiveAt: revalidated.session.lastActiveAt,
          reason: revalidated.reason,
          matchedEventType: revalidated.matchedEventType ?? null,
          matchedEventAt: revalidated.matchedEventAt ?? null
        }
      });
      continue;
    }
    activeSession = revalidated.session;

    const openRunId = activeSession.lastRunId;
    const openDispatchId = activeSession.lastDispatchId;
    await dependencies.terminateSessionProcess(project, paths, activeSession, "session_heartbeat_timeout");

    const sessionEventsBeforeTimeout = (await dependencies.repositories.events.listEvents(paths)).filter(
      (item) => item.sessionId === activeSession.sessionId
    );
    const openDispatchBeforeTimeout =
      findLatestOpenDispatch(sessionEventsBeforeTimeout) ?? findLatestDispatchStarted(sessionEventsBeforeTimeout);
    const openRunBeforeTimeout = findLatestOpenRun(sessionEventsBeforeTimeout);
    const timeoutResult = await markRunnerTimeout({
      dataRoot: dependencies.dataRoot,
      project,
      paths,
      sessionId: activeSession.sessionId,
      taskId: activeSession.currentTaskId ?? openDispatchBeforeTimeout?.event.taskId,
      runId: openRunBeforeTimeout?.runId ?? openRunId,
      dispatchId: openDispatchBeforeTimeout?.dispatchId ?? openDispatchId,
      provider: activeSession.provider ?? "minimax"
    });

    const sessionEventsAfterTimeout = (await dependencies.repositories.events.listEvents(paths)).filter(
      (item) => item.sessionId === activeSession.sessionId
    );
    const openDispatch =
      findLatestOpenDispatch(sessionEventsAfterTimeout) ??
      findLatestDispatchStarted(sessionEventsAfterTimeout) ??
      openDispatchBeforeTimeout;
    const openRun = findLatestOpenRun(sessionEventsAfterTimeout) ?? openRunBeforeTimeout;

    const dispatchIdCandidate =
      openDispatch?.dispatchId ??
      (typeof timeoutResult.session?.lastDispatchId === "string" ? timeoutResult.session.lastDispatchId : "") ??
      openDispatchId ??
      "";
    const fallbackDispatch =
      !openDispatch && dispatchIdCandidate
        ? findLatestDispatchStartedById(sessionEventsAfterTimeout, dispatchIdCandidate)
        : null;
    const dispatchToClose = openDispatch ?? fallbackDispatch;
    const hasClosed =
      dispatchIdCandidate.length > 0 ? hasDispatchClosedEvent(sessionEventsAfterTimeout, dispatchIdCandidate) : false;

    if (dispatchToClose && !hasClosed) {
      const payload = dispatchToClose.event.payload as Record<string, unknown>;
      await dependencies.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: timeoutResult.escalated ? "ORCHESTRATOR_DISPATCH_FAILED" : "ORCHESTRATOR_DISPATCH_FINISHED",
        source: "manager",
        sessionId: activeSession.sessionId,
        taskId: activeSession.currentTaskId ?? dispatchToClose.event.taskId,
        payload: {
          dispatchId: dispatchToClose.dispatchId,
          mode: payload.mode ?? "loop",
          dispatchKind: payload.dispatchKind ?? "task",
          messageId: payload.messageId ?? null,
          requestId: payload.requestId ?? null,
          runId: openRun?.runId ?? openRunId ?? null,
          exitCode: null,
          timedOut: true,
          ...(timeoutResult.escalated ? { error: "session heartbeat timeout escalated" } : {})
        }
      });
    }

    const runIdCandidate =
      openRun?.runId ??
      (typeof timeoutResult.session?.lastRunId === "string" ? timeoutResult.session.lastRunId : "") ??
      openRunId ??
      "";
    const hasRunClosed =
      runIdCandidate.length > 0 &&
      sessionEventsAfterTimeout.some((event) => {
        if (event.eventType !== "CODEX_RUN_FINISHED" && event.eventType !== "MINIMAX_RUN_FINISHED") {
          return false;
        }
        return readPayloadString(event.payload as Record<string, unknown>, "runId") === runIdCandidate;
      });

    if (runIdCandidate && !hasRunClosed) {
      const payload = (openRun?.event.payload ?? {}) as Record<string, unknown>;
      const providerId = typeof payload.provider === "string" ? payload.provider : (activeSession.provider ?? null);
      await dependencies.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: resolveSyntheticRunFinishedEventType(providerId),
        source: "manager",
        sessionId: activeSession.sessionId,
        taskId: activeSession.currentTaskId ?? openRun?.event.taskId,
        payload: {
          runId: runIdCandidate,
          exitCode: null,
          timedOut: true,
          status: "timeout",
          provider: providerId,
          mode: payload.mode ?? "exec",
          providerSessionId:
            payload.providerSessionId ?? activeSession.providerSessionId ?? activeSession.sessionId ?? null,
          synthetic: true,
          reason: "session_heartbeat_timeout"
        }
      });
    }

    await dependencies.repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "SESSION_HEARTBEAT_TIMEOUT",
      source: "manager",
      sessionId: activeSession.sessionId,
      taskId: activeSession.currentTaskId,
      payload: {
        previousStatus: "running",
        timeoutMs: dependencies.sessionRunningTimeoutMs,
        lastActiveAt: activeSession.lastActiveAt,
        escalated: timeoutResult.escalated
      }
    });
  }
}
