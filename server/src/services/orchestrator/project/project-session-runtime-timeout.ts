import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import type { ProjectPaths, ProjectRecord, SessionRecord } from "../../../domain/models.js";
import { markRunnerTimeout } from "../../session-lifecycle-authority.js";
import { findLatestOpenDispatch, readPayloadString } from "../shared/dispatch-engine.js";
import { hasOrchestratorSessionHeartbeatTimedOut } from "../shared/session-manager.js";
import {
  findLatestDispatchStarted,
  findLatestDispatchStartedById,
  findLatestOpenRun,
  hasDispatchClosedEvent
} from "./project-session-runtime-termination.js";
import { resolveProjectSessionTimeoutEvidence } from "./project-session-timeout-evidence.js";
export interface ProjectSessionTimeoutDependencies {
  dataRoot: string;
  repositories: ProjectRepositoryBundle;
  sessionRunningTimeoutMs: number;
  clearInFlightDispatchSession(projectId: string, sessionId: string): void;
  terminateSessionProcess(
    project: ProjectRecord,
    paths: ProjectPaths,
    session: SessionRecord,
    reason: string
  ): Promise<unknown>;
}

function resolveSyntheticRunFinishedEventType(
  provider: string | null | undefined
): "CODEX_RUN_FINISHED" | "MINIMAX_RUN_FINISHED" {
  return provider === "codex" ? "CODEX_RUN_FINISHED" : "MINIMAX_RUN_FINISHED";
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
  const sessionEvents = (await input.dependencies.repositories.events.listEvents(input.paths)).filter(
    (item) => item.sessionId === latestSession.sessionId
  );
  const tasks = await input.dependencies.repositories.taskboard.listTasks(input.paths, input.project.projectId);
  const currentTask = latestSession.currentTaskId
    ? (tasks.find((task) => task.taskId === latestSession.currentTaskId) ?? null)
    : null;
  const evidence = resolveProjectSessionTimeoutEvidence({
    session: latestSession,
    nowMs: input.nowMs,
    timeoutMs: input.dependencies.sessionRunningTimeoutMs,
    events: sessionEvents,
    task: currentTask
  });
  if (evidence.should_close) {
    return { skip: false, session: latestSession };
  }

  const evidenceEvent = evidence.evidence_event_id
    ? (sessionEvents.find((event) => event.eventId === evidence.evidence_event_id) ?? null)
    : null;
  const refreshedSession =
    evidence.protected_by_recent_terminal_report && evidenceEvent
      ? await input.dependencies.repositories.sessions.touchSession(
          input.paths,
          input.project.projectId,
          latestSession.sessionId,
          { lastActiveAt: evidenceEvent.createdAt }
        )
      : latestSession;
  return {
    skip: true,
    session: refreshedSession,
    reason: evidence.decision_reason === "fresh_heartbeat" ? "heartbeat_refreshed" : "recent_terminal_report",
    matchedEventType: evidenceEvent?.eventType,
    matchedEventAt: evidenceEvent?.createdAt
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
      const recoveryAttemptId = typeof payload.recovery_attempt_id === "string" ? payload.recovery_attempt_id : null;
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
          ...(recoveryAttemptId ? { recovery_attempt_id: recoveryAttemptId } : {}),
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
    dependencies.clearInFlightDispatchSession(project.projectId, activeSession.sessionId);
  }
}
