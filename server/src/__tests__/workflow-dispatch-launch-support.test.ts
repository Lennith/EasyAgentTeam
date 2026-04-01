import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWorkflowMaxTokensRecoveryEvent,
  handleWorkflowDispatchLaunchError,
  handleWorkflowDispatchLaunchResult
} from "../services/orchestrator/workflow-dispatch-launch-adapter.js";

const baseContext = {
  runId: "run-1",
  sessionId: "session-1",
  taskId: "task-1",
  requestId: "req-1",
  dispatchId: "dispatch-1",
  dispatchKind: "task" as const,
  messageId: null,
  requestedSkillIds: ["skill-1"],
  tokenLimit: 180000,
  maxOutputTokens: 16384,
  providerSessionId: "provider-session-1",
  errorStreak: 2
};

test("workflow dispatch launch support appends synthetic finished event when dispatch timed out first", async () => {
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  const touched: Array<Record<string, unknown>> = [];

  await handleWorkflowDispatchLaunchResult(
    {
      repositories: {
        events: {
          listEvents: async () => [
            {
              eventType: "SESSION_HEARTBEAT_TIMEOUT",
              sessionId: "session-1",
              createdAt: "2026-03-28T12:00:00.000Z",
              payload: { dispatchId: "dispatch-1" }
            }
          ]
        },
        sessions: {
          touchSession: async (_runId: string, _sessionId: string, patch: Record<string, unknown>) => {
            touched.push(patch);
          }
        }
      } as any,
      eventAdapter: {
        appendStarted: async () => {},
        appendFinished: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "finished", scope, details });
        },
        appendFailed: async () => {}
      }
    },
    baseContext,
    {
      finishReason: "stop",
      usage: { totalTokens: 12 },
      maxTokensRecoveryAttempt: 1,
      recoveredFromMaxTokens: true
    }
  );

  assert.deepEqual(touched, []);
  assert.deepEqual(emitted, [
    {
      kind: "finished",
      scope: {
        runId: "run-1",
        sessionId: "session-1",
        taskId: "task-1"
      },
      details: {
        requestId: "req-1",
        dispatchId: "dispatch-1",
        dispatchKind: "task",
        messageId: null,
        requestedSkillIds: ["skill-1"],
        exitCode: null,
        timedOut: true,
        synthetic: true,
        reason: "dispatch_timed_out_before_finish",
        finishReason: "stop",
        usage: { totalTokens: 12 },
        maxOutputTokens: 16384,
        tokenLimit: 180000,
        maxTokensRecoveryAttempt: 1,
        maxTokensSnapshotPath: null,
        recoveredFromMaxTokens: true
      }
    }
  ]);
});

test("workflow dispatch launch support appends failed event and dismisses session on open launch error", async () => {
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  const touched: Array<Record<string, unknown>> = [];

  await handleWorkflowDispatchLaunchError(
    {
      repositories: {
        events: {
          listEvents: async () => []
        },
        sessions: {
          getSession: async () => ({ errorStreak: 3 }),
          touchSession: async (_runId: string, _sessionId: string, patch: Record<string, unknown>) => {
            touched.push(patch);
          }
        }
      } as any,
      eventAdapter: {
        appendStarted: async () => {},
        appendFinished: async () => {},
        appendFailed: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "failed", scope, details });
        }
      }
    },
    baseContext,
    new Error("provider launch failed")
  );

  assert.deepEqual(emitted, [
    {
      kind: "failed",
      scope: {
        runId: "run-1",
        sessionId: "session-1",
        taskId: "task-1"
      },
      details: {
        requestId: "req-1",
        dispatchId: "dispatch-1",
        dispatchKind: "task",
        messageId: null,
        requestedSkillIds: ["skill-1"],
        error: "provider launch failed"
      }
    }
  ]);
  assert.deepEqual(touched, [
    {
      status: "dismissed",
      errorStreak: 4,
      lastFailureAt: touched[0]?.lastFailureAt,
      lastFailureKind: "error",
      cooldownUntil: null,
      agentPid: null,
      lastRunId: "run-1"
    }
  ]);
  assert.equal(typeof (touched[0]?.lastFailureAt as string | undefined), "string");
});

test("workflow dispatch launch support writes max-tokens recovery event with dispatch metadata", async () => {
  const appended: Array<Record<string, unknown>> = [];

  await appendWorkflowMaxTokensRecoveryEvent(
    {
      events: {
        appendEvent: async (_runId: string, event: Record<string, unknown>) => {
          appended.push(event);
        }
      }
    } as any,
    baseContext,
    {
      observedAt: "2026-03-28T12:00:00.000Z",
      step: 6,
      attempt: 1,
      maxAttempts: 3,
      recovered: true,
      finishReason: "max_tokens",
      preCompressMessageCount: 22,
      preCompressChars: 2048,
      postCompressMessageCount: 8,
      postCompressChars: 512,
      compactedToolCallChains: 2,
      compactedToolMessages: 4,
      compressionMode: "llm_compressor",
      continuationInjected: true
    }
  );

  assert.deepEqual(appended, [
    {
      eventType: "MINIMAX_MAX_TOKENS_RECOVERY",
      source: "system",
      sessionId: "session-1",
      taskId: "task-1",
      payload: {
        requestId: "req-1",
        dispatchId: "dispatch-1",
        runId: "run-1",
        dispatchKind: "task",
        messageId: null,
        tokenLimit: 180000,
        maxOutputTokens: 16384,
        observedAt: "2026-03-28T12:00:00.000Z",
        step: 6,
        attempt: 1,
        maxAttempts: 3,
        recovered: true,
        finishReason: "max_tokens",
        preCompressMessageCount: 22,
        preCompressChars: 2048,
        postCompressMessageCount: 8,
        postCompressChars: 512,
        compactedToolCallChains: 2,
        compactedToolMessages: 4,
        compressionMode: "llm_compressor",
        continuationInjected: true
      }
    }
  ]);
});
