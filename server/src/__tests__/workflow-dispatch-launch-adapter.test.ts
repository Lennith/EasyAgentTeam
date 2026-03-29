import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowDispatchLaunchAdapter } from "../services/orchestrator/workflow-dispatch-launch-adapter.js";

test("workflow dispatch launch adapter dismisses session when minimax is not configured", async () => {
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  const touchedSessions: Array<{ runId: string; sessionId: string; patch: Record<string, unknown> }> = [];
  let runSessionCalled = false;

  const adapter = new WorkflowDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        runSessionWithTools: async () => {
          runSessionCalled = true;
          throw new Error("should not run provider launch when minimax is not configured");
        }
      } as any,
      repositories: {
        sessions: {
          touchSession: async (runId: string, sessionId: string, patch: Record<string, unknown>) => {
            touchedSessions.push({ runId, sessionId, patch });
          },
          getSession: async () => null
        },
        events: {
          appendEvent: async () => {}
        }
      } as any,
      touchSessionHeartbeat: async () => {},
      ensureRuntime: async () => {
        throw new Error("should not resolve runtime before minimax config guard");
      },
      applyTaskActions: async () => ({ appliedTaskIds: [] }) as any,
      sendRunMessage: async () => ({}),
      eventAdapter: {
        appendStarted: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "started", scope, details });
        },
        appendFinished: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "finished", scope, details });
        },
        appendFailed: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "failed", scope, details });
        }
      } as any
    },
    {
      listAgents: async () =>
        [
          {
            agentId: "dev",
            prompt: "you are dev",
            summary: "developer",
            skillList: ["skill-1"]
          }
        ] as any,
      resolveSkillIdsForAgent: async () => ["skill-1"],
      resolveImportedSkillPromptSegments: async () => ({ segments: ["skill prompt"] }) as any,
      getRuntimeSettings: async () => ({ minimaxApiKey: "" }) as any,
      ensureAgentWorkspaces: async () => ({ created: [], updated: [] }) as any,
      buildDefaultRolePrompt: () => "default prompt"
    }
  );

  await adapter.launch({
    run: {
      runId: "run-1",
      name: "Workflow Run",
      workspacePath: "C:\\workspace\\wf",
      createdAt: "2026-03-28T10:00:00.000Z",
      updatedAt: "2026-03-28T10:00:00.000Z",
      tasks: [{ ownerRole: "dev" }]
    } as any,
    session: {
      sessionId: "session-1",
      role: "dev",
      provider: "minimax",
      errorStreak: 2
    } as any,
    role: "dev",
    dispatchKind: "task",
    taskId: "task-1",
    message: null,
    requestId: "req-1",
    dispatchId: "dispatch-1"
  });

  assert.equal(runSessionCalled, false);
  assert.deepEqual(emitted, [
    {
      kind: "started",
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
        tokenLimit: 180000,
        maxOutputTokens: 16384
      }
    },
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
        error: "minimax_not_configured"
      }
    }
  ]);
  assert.deepEqual(touchedSessions, [
    {
      runId: "run-1",
      sessionId: "session-1",
      patch: {
        status: "dismissed",
        errorStreak: 3,
        lastFailureAt: touchedSessions[0]?.patch.lastFailureAt,
        lastFailureKind: "error",
        cooldownUntil: null,
        agentPid: null
      }
    }
  ]);
  assert.equal(typeof (touchedSessions[0]?.patch.lastFailureAt as string | undefined), "string");
});
