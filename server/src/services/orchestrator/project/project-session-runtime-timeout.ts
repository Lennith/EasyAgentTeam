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
    if (
      !hasOrchestratorSessionHeartbeatTimedOut({
        lastActiveAt: session.lastActiveAt,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        timeoutMs: dependencies.sessionRunningTimeoutMs,
        nowMs
      })
    ) {
      continue;
    }

    const openRunId = session.lastRunId;
    const openDispatchId = session.lastDispatchId;
    await dependencies.terminateSessionProcess(project, paths, session, "session_heartbeat_timeout");

    const sessionEventsBeforeTimeout = (await dependencies.repositories.events.listEvents(paths)).filter(
      (item) => item.sessionId === session.sessionId
    );
    const openDispatchBeforeTimeout =
      findLatestOpenDispatch(sessionEventsBeforeTimeout) ?? findLatestDispatchStarted(sessionEventsBeforeTimeout);
    const openRunBeforeTimeout = findLatestOpenRun(sessionEventsBeforeTimeout);
    const timeoutResult = await markRunnerTimeout({
      dataRoot: dependencies.dataRoot,
      project,
      paths,
      sessionId: session.sessionId,
      taskId: session.currentTaskId ?? openDispatchBeforeTimeout?.event.taskId,
      runId: openRunBeforeTimeout?.runId ?? openRunId,
      dispatchId: openDispatchBeforeTimeout?.dispatchId ?? openDispatchId,
      provider: session.provider ?? "minimax"
    });

    const sessionEventsAfterTimeout = (await dependencies.repositories.events.listEvents(paths)).filter(
      (item) => item.sessionId === session.sessionId
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
        sessionId: session.sessionId,
        taskId: session.currentTaskId ?? dispatchToClose.event.taskId,
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
      await dependencies.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "CODEX_RUN_FINISHED",
        source: "manager",
        sessionId: session.sessionId,
        taskId: session.currentTaskId ?? openRun?.event.taskId,
        payload: {
          runId: runIdCandidate,
          exitCode: null,
          timedOut: true,
          status: "timeout",
          provider: payload.provider ?? session.provider ?? null,
          mode: payload.mode ?? "exec",
          providerSessionId: payload.providerSessionId ?? session.providerSessionId ?? session.sessionId ?? null,
          synthetic: true,
          reason: "session_heartbeat_timeout"
        }
      });
    }

    await dependencies.repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "SESSION_HEARTBEAT_TIMEOUT",
      source: "manager",
      sessionId: session.sessionId,
      taskId: session.currentTaskId,
      payload: {
        previousStatus: "running",
        timeoutMs: dependencies.sessionRunningTimeoutMs,
        lastActiveAt: session.lastActiveAt,
        escalated: timeoutResult.escalated
      }
    });
  }
}
