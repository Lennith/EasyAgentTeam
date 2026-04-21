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

export async function markWorkflowTimedOutSessions(
  dependencies: WorkflowSessionTimeoutDependencies,
  run: WorkflowRunRecord,
  sessions: WorkflowSessionRecord[]
): Promise<void> {
  const nowMs = Date.now();
  const threshold = getTimeoutEscalationThreshold();
  const cooldownMs = getTimeoutCooldownMs();
  const settings = await getRuntimeSettings(dependencies.dataRoot);
  const events = await dependencies.repositories.events.listEvents(run.runId);
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
        timeoutMs: dependencies.sessionRunningTimeoutMs,
        nowMs
      })
    ) {
      continue;
    }
    const providerId = session.provider ?? resolveSessionProviderId(run, session.role, "minimax");
    const cancelSessionId = resolveOrchestratorProviderSessionId(session.sessionId, session.providerSessionId);
    const cancelRequested = dependencies.providerRegistry.cancelSession(providerId, cancelSessionId);
    const sessionEvents = events.filter((event) => event.sessionId === session.sessionId);
    const openDispatch = findLatestOpenDispatch(sessionEvents);
    const currentTaskId = session.currentTaskId ?? openDispatch?.event.taskId ?? null;
    const dispatchId = openDispatch?.dispatchId ?? session.lastDispatchId ?? null;
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
      existing_timeout_streak: session.timeoutStreak ?? 0,
      timeout_threshold: threshold,
      timeout_cooldown_ms: cooldownMs
    });
    const timeoutStreak = transition.session_patch.timeoutStreak ?? (session.timeoutStreak ?? 0) + 1;
    const escalated = transition.escalated;
    const cooldownUntil = transition.cooldown_until;
    const timeoutDump =
      !escalated && providerId === "minimax"
        ? await dumpSessionMessagesOnSoftTimeout({
            workspacePath: run.workspacePath,
            sessionDir: settings.minimaxSessionDir || buildOrchestratorMinimaxSessionDir(run.workspacePath),
            sessionId: session.sessionId,
            providerSessionId: session.providerSessionId,
            runId: run.runId,
            role: session.role,
            provider: providerId,
            dispatchId,
            taskId: currentTaskId ?? null,
            timeoutStreak
          })
        : null;

    await dependencies.repositories.runInUnitOfWork({ run }, async () => {
      await dependencies.repositories.sessions
        .touchSession(run.runId, session.sessionId, {
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
        await dependencies.repositories.events.appendEvent(run.runId, {
          eventType: escalated ? "ORCHESTRATOR_DISPATCH_FAILED" : "ORCHESTRATOR_DISPATCH_FINISHED",
          source: "system",
          sessionId: session.sessionId,
          taskId: currentTaskId ?? undefined,
          payload: {
            dispatchId: openDispatch.dispatchId,
            mode: payload.mode ?? "loop",
            dispatchKind: payload.dispatchKind ?? "task",
            messageId: payload.messageId ?? null,
            requestId: payload.requestId ?? null,
            runId: run.runId,
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
        sessionId: session.sessionId,
        taskId: currentTaskId ?? undefined,
        payload: {
          previous_status: "running",
          timeout_ms: dependencies.sessionRunningTimeoutMs,
          last_active_at: session.lastActiveAt,
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
        sessionId: session.sessionId,
        taskId: currentTaskId ?? undefined,
        payload: {
          ...transition.event_payload,
          timeout_message_dump_path: timeoutDump?.filePath ?? null,
          timeout_message_count: timeoutDump?.messageCount ?? null
        }
      });
      await dependencies.repositories.sessions
        .touchSession(run.runId, session.sessionId, {
          lastFailureEventId: failureEvent.eventId
        })
        .catch(() => {});
    });
    dependencies.clearInFlightDispatchSession(run.runId, session.sessionId);
  }
}
