import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowDispatchLaunchAdapter } from "../services/orchestrator/workflow/workflow-dispatch-launch-adapter.js";
import { ProviderLaunchError } from "../services/provider-launch-error.js";

test("workflow dispatch launch adapter blocks session when minimax is not configured", async () => {
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
          appendEvent: async () => ({ eventId: "event-missing-config" })
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
        status: "blocked",
        currentTaskId: "task-1",
        errorStreak: 3,
        lastFailureAt: touchedSessions[0]?.patch.lastFailureAt,
        lastFailureKind: "error",
        lastFailureDispatchId: "dispatch-1",
        lastFailureMessageId: null,
        lastFailureTaskId: "task-1",
        cooldownUntil: null,
        agentPid: null,
        lastRunId: "run-1"
      }
    },
    {
      runId: "run-1",
      sessionId: "session-1",
      patch: {
        lastFailureEventId: "event-missing-config"
      }
    }
  ]);
  assert.equal(typeof (touchedSessions[0]?.patch.lastFailureAt as string | undefined), "string");
});

test("workflow dispatch launch adapter blocks session on provider config error", async () => {
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  const touchedSessions: Array<{ runId: string; sessionId: string; patch: Record<string, unknown> }> = [];
  const appendedEvents: Array<Record<string, unknown>> = [];

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
          appendEvent: async (_runId: string, event: Record<string, unknown>) => {
            appendedEvents.push(event);
            return { eventId: "event-config-error" };
          },
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
  assert.equal(touchedSessions.length, 2);
  assert.equal(touchedSessions[0]?.patch.status, "blocked");
  assert.deepEqual(touchedSessions[1], {
    runId: "run-blocked",
    sessionId: "session-blocked",
    patch: {
      lastFailureEventId: "event-config-error"
    }
  });
  const blockedEvent = appendedEvents.find((event) => event.eventType === "RUNNER_CONFIG_ERROR_BLOCKED");
  assert.ok(blockedEvent);
  assert.deepEqual(blockedEvent?.payload, {
    request_id: "req-blocked",
    run_id: "run-blocked",
    dispatch_id: "dispatch-blocked",
    dispatch_kind: "task",
    message_id: null,
    error: "Codex provider cannot use MiniMax model 'MiniMax-M2.5'.",
    code: "PROVIDER_MODEL_MISMATCH",
    retryable: false,
    next_action: "Use a Codex model such as gpt-5.3-codex, or switch provider to minimax.",
    raw_status: null
  });
});

test("workflow dispatch launch adapter keeps transient provider errors retryable with cooldown", async () => {
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  const appendedEvents: Array<Record<string, unknown>> = [];
  const touchedSessions: Array<{ runId: string; sessionId: string; patch: Record<string, unknown> }> = [];
  const originalCooldown = process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS;
  process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS = "30000";

  try {
    const adapter = new WorkflowDispatchLaunchAdapter(
      {
        dataRoot: "C:\\memory",
        providerRegistry: {
          runSessionWithTools: async () => {
            throw new ProviderLaunchError({
              code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
              category: "runtime",
              retryable: true,
              message: "MiniMax upstream returned transient status 529.",
              nextAction: "Wait for cooldown and retry the same task/message dispatch.",
              details: {
                status: 529
              }
            });
          }
        } as any,
        repositories: {
          sessions: {
            touchSession: async (runId: string, sessionId: string, patch: Record<string, unknown>) => {
              touchedSessions.push({ runId, sessionId, patch });
            },
            getSession: async () => ({ errorStreak: 1 })
          },
          events: {
            appendEvent: async (_runId: string, event: Record<string, unknown>) => {
              appendedEvents.push(event);
              return { eventId: "event-transient-error" };
            },
            listEvents: async () => []
          }
        } as any,
        touchSessionHeartbeat: async () => {},
        ensureRuntime: async () => ({ tasks: [] }) as any,
        applyTaskActions: async () => ({ appliedTaskIds: [] }) as any,
        sendRunMessage: async () => ({}),
        eventAdapter: {
          appendStarted: async () => {},
          appendFinished: async () => {},
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
        getRuntimeSettings: async () => ({ minimaxApiKey: "test-key" }) as any,
        ensureAgentWorkspaces: async () => ({ created: [], updated: [] }) as any,
        buildDefaultRolePrompt: () => "default prompt"
      }
    );

    await adapter.launch({
      run: {
        runId: "run-transient",
        name: "Workflow Run",
        workspacePath: "C:\\workspace\\wf",
        createdAt: "2026-04-17T10:00:00.000Z",
        updatedAt: "2026-04-17T10:00:00.000Z",
        tasks: [{ ownerRole: "lead" }]
      } as any,
      session: {
        sessionId: "session-transient",
        role: "lead",
        provider: "minimax",
        errorStreak: 1
      } as any,
      role: "lead",
      dispatchKind: "task",
      taskId: "task-transient",
      message: null,
      requestId: "req-transient",
      dispatchId: "dispatch-transient"
    });

    assert.equal(emitted.length, 1);
    assert.equal(touchedSessions.length, 2);
    assert.equal(touchedSessions[0]?.patch.status, "idle");
    assert.equal(touchedSessions[0]?.patch.currentTaskId, "task-transient");
    assert.equal(typeof touchedSessions[0]?.patch.cooldownUntil, "string");
    assert.deepEqual(touchedSessions[1], {
      runId: "run-transient",
      sessionId: "session-transient",
      patch: {
        lastFailureEventId: "event-transient-error"
      }
    });
    const transientEvent = appendedEvents.find((event) => event.eventType === "RUNNER_TRANSIENT_ERROR_SOFT");
    assert.ok(transientEvent);
    assert.deepEqual(transientEvent?.payload, {
      request_id: "req-transient",
      run_id: "run-transient",
      dispatch_id: "dispatch-transient",
      dispatch_kind: "task",
      message_id: null,
      error: "MiniMax upstream returned transient status 529.",
      code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
      retryable: true,
      next_action: "Wait for cooldown and retry the same task/message dispatch.",
      raw_status: 529,
      cooldown_until: touchedSessions[0]?.patch.cooldownUntil ?? null
    });
  } finally {
    if (originalCooldown === undefined) {
      delete process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS;
    } else {
      process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS = originalCooldown;
    }
  }
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
            return { eventId: "event-observation" };
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
