import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowDispatchLaunchAdapter } from "../services/orchestrator/workflow/workflow-dispatch-launch-adapter.js";
import { ProviderLaunchError } from "../services/provider-launch-error.js";

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

test("workflow dispatch launch adapter blocks session on provider config error", async () => {
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  const touchedSessions: Array<{ runId: string; sessionId: string; patch: Record<string, unknown> }> = [];

  const adapter = new WorkflowDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        runSessionWithTools: async () => {
          throw new ProviderLaunchError({
            code: "PROVIDER_MODEL_MISMATCH",
            category: "config",
            retryable: false,
            message: "Codex provider cannot use MiniMax model 'MiniMax-M2.5'.",
            nextAction: "Use a Codex model such as gpt-5.3-codex, or switch provider to minimax."
          });
        }
      } as any,
      repositories: {
        sessions: {
          touchSession: async (runId: string, sessionId: string, patch: Record<string, unknown>) => {
            touchedSessions.push({ runId, sessionId, patch });
          },
          getSession: async () => ({ errorStreak: 0 })
        },
        events: {
          appendEvent: async () => {},
          listEvents: async () => []
        }
      } as any,
      touchSessionHeartbeat: async () => {},
      ensureRuntime: async () => ({ tasks: [] }) as any,
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
            agentId: "lead",
            prompt: "you are lead",
            summary: "lead"
          }
        ] as any,
      resolveSkillIdsForAgent: async () => [],
      resolveImportedSkillPromptSegments: async () => ({ segments: [] }) as any,
      getRuntimeSettings: async () => ({ codexCliCommand: "codex" }) as any,
      ensureAgentWorkspaces: async () => ({ created: [], updated: [] }) as any,
      buildDefaultRolePrompt: () => "default prompt"
    }
  );

  await adapter.launch({
    run: {
      runId: "run-blocked",
      name: "Workflow Run",
      workspacePath: "C:\\workspace\\wf",
      createdAt: "2026-04-12T10:00:00.000Z",
      updatedAt: "2026-04-12T10:00:00.000Z",
      tasks: [{ ownerRole: "lead" }]
    } as any,
    session: {
      sessionId: "session-blocked",
      role: "lead",
      provider: "codex",
      errorStreak: 0
    } as any,
    role: "lead",
    dispatchKind: "task",
    taskId: "task-blocked",
    message: null,
    requestId: "req-blocked",
    dispatchId: "dispatch-blocked"
  });

  assert.equal(
    emitted.some((item) => item.kind === "failed"),
    true
  );
  assert.equal(touchedSessions.length, 1);
  assert.equal(touchedSessions[0]?.patch.status, "blocked");
});

test("workflow dispatch launch adapter records codex provider observations", async () => {
  const appendedEvents: Array<Record<string, unknown>> = [];
  const touchedSessions: Array<{ runId: string; sessionId: string; patch: Record<string, unknown> }> = [];
  const heartbeatTouches: Array<{ runId: string; sessionId: string }> = [];

  const adapter = new WorkflowDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        runSessionWithTools: async (_providerId: string, _settings: unknown, input: any) => {
          await input.callback?.onProviderObservation?.({
            providerId: "codex",
            kind: "launch_config",
            providerSessionId: "session-observe",
            details: {
              model: "gpt-5.4",
              effort: "medium"
            }
          });
          await input.callback?.onProviderObservation?.({
            providerId: "codex",
            kind: "heartbeat",
            providerSessionId: "codex-thread-1",
            details: {
              source: "timer"
            }
          });
          await input.callback?.onProviderObservation?.({
            providerId: "codex",
            kind: "thread_started",
            providerSessionId: "codex-thread-1",
            step: 1,
            details: {
              thread_id: "codex-thread-1"
            }
          });
          assert.deepEqual(touchedSessions[0], {
            runId: "run-observe",
            sessionId: "session-observe",
            patch: {
              providerSessionId: "codex-thread-1"
            }
          });
          return {
            content: "done",
            sessionId: "codex-thread-1",
            providerSessionId: "codex-thread-1",
            finishReason: "stop",
            step: 1
          };
        }
      } as any,
      repositories: {
        sessions: {
          touchSession: async (runId: string, sessionId: string, patch: Record<string, unknown>) => {
            touchedSessions.push({ runId, sessionId, patch });
          },
          getSession: async () => ({ errorStreak: 0 })
        },
        events: {
          appendEvent: async (_runId: string, event: Record<string, unknown>) => {
            appendedEvents.push(event);
          },
          listEvents: async () => []
        }
      } as any,
      touchSessionHeartbeat: async (runId: string, sessionId: string) => {
        heartbeatTouches.push({ runId, sessionId });
      },
      ensureRuntime: async () => ({ tasks: [] }) as any,
      applyTaskActions: async () => ({ appliedTaskIds: [] }) as any,
      sendRunMessage: async () => ({}),
      eventAdapter: {
        appendStarted: async () => {},
        appendFinished: async () => {},
        appendFailed: async () => {}
      } as any
    },
    {
      listAgents: async () =>
        [
          {
            agentId: "lead",
            prompt: "you are lead",
            summary: "lead"
          }
        ] as any,
      resolveSkillIdsForAgent: async () => [],
      resolveImportedSkillPromptSegments: async () => ({ segments: [] }) as any,
      getRuntimeSettings: async () => ({ codexCliCommand: "codex" }) as any,
      ensureAgentWorkspaces: async () => ({ created: [], updated: [] }) as any,
      buildDefaultRolePrompt: () => "default prompt"
    }
  );

  await adapter.launch({
    run: {
      runId: "run-observe",
      name: "Workflow Run",
      workspacePath: "C:\\workspace\\wf",
      createdAt: "2026-04-12T12:00:00.000Z",
      updatedAt: "2026-04-12T12:00:00.000Z",
      tasks: [{ ownerRole: "lead" }]
    } as any,
    session: {
      sessionId: "session-observe",
      role: "lead",
      provider: "codex",
      errorStreak: 0
    } as any,
    role: "lead",
    dispatchKind: "task",
    taskId: "task-observe",
    message: null,
    requestId: "req-observe",
    dispatchId: "dispatch-observe"
  });

  const observationEvent = appendedEvents.find(
    (event) =>
      event.eventType === "PROVIDER_OBSERVATION_RECORDED" &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).kind === "thread_started"
  );
  const launchConfigEvent = appendedEvents.find(
    (event) =>
      event.eventType === "PROVIDER_OBSERVATION_RECORDED" &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).kind === "launch_config"
  );
  const heartbeatEvent = appendedEvents.find(
    (event) =>
      event.eventType === "PROVIDER_OBSERVATION_RECORDED" &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).kind === "heartbeat"
  );
  assert.ok(observationEvent);
  assert.ok(launchConfigEvent);
  assert.ok(heartbeatEvent);
  assert.equal((observationEvent?.payload as Record<string, unknown>).providerId, "codex");
  assert.equal((observationEvent?.payload as Record<string, unknown>).providerSessionId, "codex-thread-1");
  assert.equal(
    ((launchConfigEvent?.payload as Record<string, unknown>).details as Record<string, unknown>).model,
    "gpt-5.4"
  );
  assert.equal(
    ((launchConfigEvent?.payload as Record<string, unknown>).details as Record<string, unknown>).effort,
    "medium"
  );
  assert.equal(
    touchedSessions.some((entry) => entry.patch.providerSessionId === "codex-thread-1"),
    true
  );
  assert.equal(heartbeatTouches.length, 3);
});
