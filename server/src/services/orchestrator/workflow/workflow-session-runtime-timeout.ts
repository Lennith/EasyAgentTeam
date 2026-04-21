import { getTimeoutCooldownMs, getTimeoutEscalationThreshold } from "../../session-lifecycle-authority.js";
import { dumpSessionMessagesOnSoftTimeout } from "../../session-timeout-message-dump.js";
import { resolveSessionProviderId, type ProviderRegistry } from "../../provider-runtime.js";
import type { WorkflowRunRecord, WorkflowSessionRecord } from "../../../domain/models.js";
import { hasOrchestratorSessionHeartbeatTimedOut } from "../shared/session-manager.js";
import { findLatestOpenDispatch } from "../shared/dispatch-engine.js";
import { getRuntimeSettings } from "../../../data/repository/system/runtime-settings-repository.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { resolveRunnerFailureTransition } from "../shared/runner-failure-transition.js";
import {
  buildOrchestratorMinimaxSessionDir,
  resolveOrchestratorProviderSessionId
} from "../shared/orchestrator-runtime-helpers.js";
import { resolveWorkflowSessionTimeoutEvidence } from "./workflow-session-timeout-evidence.js";

export interface WorkflowSessionTimeoutDependencies {
  dataRoot: string;
  repositories: WorkflowRepositoryBundle;
  providerRegistry: ProviderRegistry;
  sessionRunningTimeoutMs: number;
  clearInFlightDispatchSession(runId: string, sessionId: string): void;
  resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason?: string
  ): Promise<WorkflowSessionRecord | null>;
}

async function revalidateTimedOutWorkflowSession(input: {
  dependencies: WorkflowSessionTimeoutDependencies;
  run: WorkflowRunRecord;
  session: WorkflowSessionRecord;
  nowMs: number;
}): Promise<
  | { skip: false; session: WorkflowSessionRecord }
  | {
      skip: true;
      session: WorkflowSessionRecord;
      reason: "fresh_heartbeat" | "recent_terminal_report";
      matchedEventType?: string;
      matchedEventAt?: string;
    }
> {
  const latestSession =
    (await input.dependencies.repositories.sessions.getSession(input.run.runId, input.session.sessionId)) ??
    input.session;
  const events = (await input.dependencies.repositories.events.listEvents(input.run.runId)).filter(
    (item) => item.sessionId === latestSession.sessionId
  );
  const runtime = await input.dependencies.repositories.workflowRuns.readRuntime(input.run.runId);
  const currentTask = latestSession.currentTaskId
    ? (runtime.tasks.find((task) => task.taskId === latestSession.currentTaskId) ?? null)
    : null;
  const evidence = resolveWorkflowSessionTimeoutEvidence({
    session: latestSession,
    nowMs: input.nowMs,
    timeoutMs: input.dependencies.sessionRunningTimeoutMs,
    events,
    task: currentTask
  });
  if (evidence.should_close) {
    return { skip: false, session: latestSession };
  }

  const evidenceEvent = evidence.evidence_event_id
    ? (events.find((event) => event.eventId === evidence.evidence_event_id) ?? null)
    : null;
  const refreshedSession =
    evidence.protected_by_recent_terminal_report && evidenceEvent
      ? await input.dependencies.repositories.sessions.touchSession(input.run.runId, latestSession.sessionId, {
          lastActiveAt: evidenceEvent.createdAt
        })
      : latestSession;
  return {
    skip: true,
    session: refreshedSession,
    reason: evidence.decision_reason === "fresh_heartbeat" ? "fresh_heartbeat" : "recent_terminal_report",
    matchedEventType: evidenceEvent?.eventType,
    matchedEventAt: evidenceEvent?.createdAt
  };
}

export async function markWorkflowTimedOutSessions(
  dependencies: WorkflowSessionTimeoutDependencies,
  run: WorkflowRunRecord,
  sessions: WorkflowSessionRecord[]
): Promise<void> {
  const nowMs = Date.now();
  const threshold = getTimeoutEscalationThreshold();
  const cooldownMs = getTimeoutCooldownMs();
  const settings = await getRuntimeSettings(dependencies.dataRoot);
  const roleCandidates = Array.from(
    new Set(sessions.filter((session) => session.status !== "dismissed").map((session) => session.role))
  ).sort((a, b) => a.localeCompare(b));

  for (const role of roleCandidates) {
    const session = await dependencies.resolveAuthoritativeSession(run.runId, role, sessions, run, "timeout_check");
    if (!session || session.status !== "running") {
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
    const revalidated = await revalidateTimedOutWorkflowSession({
      dependencies,
      run,
      session,
      nowMs
    });
    if (revalidated.skip) {
      await dependencies.repositories.events.appendEvent(run.runId, {
        eventType: "SESSION_HEARTBEAT_TIMEOUT_SKIPPED",
        source: "system",
        sessionId: revalidated.session.sessionId,
        taskId: revalidated.session.currentTaskId ?? session.currentTaskId ?? undefined,
        payload: {
          previous_status: "running",
          timeout_ms: dependencies.sessionRunningTimeoutMs,
          last_active_at: session.lastActiveAt,
          revalidated_last_active_at: revalidated.session.lastActiveAt,
          reason: revalidated.reason,
          matched_event_type: revalidated.matchedEventType ?? null,
          matched_event_at: revalidated.matchedEventAt ?? null
        }
      });
      continue;
    }
    const activeSession = revalidated.session;
    const providerId = activeSession.provider ?? resolveSessionProviderId(run, activeSession.role, "minimax");
    const cancelSessionId = resolveOrchestratorProviderSessionId(
      activeSession.sessionId,
      activeSession.providerSessionId
    );
    const cancelRequested = dependencies.providerRegistry.cancelSession(providerId, cancelSessionId);
    const sessionEvents = (await dependencies.repositories.events.listEvents(run.runId)).filter(
      (event) => event.sessionId === activeSession.sessionId
    );
    const openDispatch = findLatestOpenDispatch(sessionEvents);
    const currentTaskId = activeSession.currentTaskId ?? openDispatch?.event.taskId ?? null;
    const dispatchId = openDispatch?.dispatchId ?? activeSession.lastDispatchId ?? null;
    const dispatchPayload = (openDispatch?.event.payload as Record<string, unknown> | undefined) ?? undefined;
    const transition = resolveRunnerFailureTransition({
      kind: "timeout",
      run_id: run.runId,
      dispatch_id: dispatchId,
      dispatch_kind: dispatchPayload?.dispatchKind === "message" ? "message" : "task",
      message_id:
        typeof dispatchPayload?.messageId === "string" && dispatchPayload.messageId.trim().length > 0
          ? dispatchPayload.messageId
          : null,
      current_task_id: currentTaskId,
      preserve_current_task_id: true,
      existing_timeout_streak: activeSession.timeoutStreak ?? 0,
      timeout_threshold: threshold,
      timeout_cooldown_ms: cooldownMs
    });
    const timeoutStreak = transition.session_patch.timeoutStreak ?? (activeSession.timeoutStreak ?? 0) + 1;
    const escalated = transition.escalated;
    const cooldownUntil = transition.cooldown_until;
    const timeoutDump =
      !escalated && providerId === "minimax"
        ? await dumpSessionMessagesOnSoftTimeout({
            workspacePath: run.workspacePath,
            sessionDir: settings.minimaxSessionDir || buildOrchestratorMinimaxSessionDir(run.workspacePath),
            sessionId: activeSession.sessionId,
            providerSessionId: activeSession.providerSessionId,
            runId: run.runId,
            role: activeSession.role,
            provider: providerId,
            dispatchId,
            taskId: currentTaskId ?? null,
            timeoutStreak
          })
        : null;

    await dependencies.repositories.runInUnitOfWork({ run }, async () => {
      await dependencies.repositories.sessions
        .touchSession(run.runId, activeSession.sessionId, {
          status: transition.session_patch.status,
          currentTaskId: transition.session_patch.currentTaskId ?? currentTaskId,
          lastDispatchId: dispatchId,
          timeoutStreak: transition.session_patch.timeoutStreak,
          lastFailureAt: transition.session_patch.lastFailureAt,
          lastFailureKind: transition.session_patch.lastFailureKind,
          lastFailureDispatchId: dispatchId,
          lastFailureMessageId:
            typeof dispatchPayload?.messageId === "string" && dispatchPayload.messageId.trim().length > 0
              ? dispatchPayload.messageId
              : null,
          lastFailureTaskId: transition.session_patch.currentTaskId ?? currentTaskId,
          cooldownUntil: transition.session_patch.cooldownUntil,
          agentPid: null,
          lastRunId: run.runId
        })
        .catch(() => {});
      if (openDispatch) {
        const payload = openDispatch.event.payload as Record<string, unknown>;
        const recoveryAttemptId = typeof payload.recovery_attempt_id === "string" ? payload.recovery_attempt_id : null;
        await dependencies.repositories.events.appendEvent(run.runId, {
          eventType: escalated ? "ORCHESTRATOR_DISPATCH_FAILED" : "ORCHESTRATOR_DISPATCH_FINISHED",
          source: "system",
          sessionId: activeSession.sessionId,
          taskId: currentTaskId ?? undefined,
          payload: {
            dispatchId: openDispatch.dispatchId,
            mode: payload.mode ?? "loop",
            dispatchKind: payload.dispatchKind ?? "task",
            messageId: payload.messageId ?? null,
            requestId: payload.requestId ?? null,
            runId: run.runId,
            ...(recoveryAttemptId ? { recovery_attempt_id: recoveryAttemptId } : {}),
            exitCode: null,
            timedOut: true,
            synthetic: true,
            reason: "session_heartbeat_timeout",
            ...(escalated ? { error: "session heartbeat timeout escalated" } : {})
          }
        });
      }
      await dependencies.repositories.events.appendEvent(run.runId, {
        eventType: "SESSION_HEARTBEAT_TIMEOUT",
        source: "system",
        sessionId: activeSession.sessionId,
        taskId: currentTaskId ?? undefined,
        payload: {
          previous_status: "running",
          timeout_ms: dependencies.sessionRunningTimeoutMs,
          last_active_at: activeSession.lastActiveAt,
          provider: providerId,
          provider_session_id: cancelSessionId,
          cancel_requested: cancelRequested,
          timeout_streak: timeoutStreak,
          threshold,
          escalated,
          cooldown_until: cooldownUntil,
          dispatch_id: dispatchId
        }
      });
      const failureEvent = await dependencies.repositories.events.appendEvent(run.runId, {
        eventType: transition.event_type,
        source: "system",
        sessionId: activeSession.sessionId,
        taskId: currentTaskId ?? undefined,
        payload: {
          ...transition.event_payload,
          timeout_message_dump_path: timeoutDump?.filePath ?? null,
          timeout_message_count: timeoutDump?.messageCount ?? null
        }
      });
      await dependencies.repositories.sessions
        .touchSession(run.runId, activeSession.sessionId, {
          lastFailureEventId: failureEvent.eventId
        })
        .catch(() => {});
    });
    dependencies.clearInFlightDispatchSession(run.runId, session.sessionId);
  }
}
