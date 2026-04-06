import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowReminderService } from "../services/orchestrator/workflow/workflow-reminder-service.js";

test("workflow reminder service triggers reminder, appends inbox/event, and redispatches", async () => {
  const inboxMessages: Array<{ role: string; message: Record<string, unknown> }> = [];
  const appendedEvents: Array<Record<string, unknown>> = [];
  const reminderStates = new Map<string, any>();
  const dispatchCalls: Array<Record<string, unknown>> = [];
  const idleSession = {
    sessionId: "session-dev",
    role: "dev",
    status: "idle",
    updatedAt: "2026-03-28T12:00:00.000Z",
    lastDispatchedAt: "2000-01-01T00:00:00.000Z"
  };
  const run = {
    runId: "run-reminder",
    reminderMode: "backoff",
    createdAt: "2026-03-28T00:00:00.000Z",
    tasks: [
      {
        taskId: "task-a",
        resolvedTitle: "Task A",
        ownerRole: "dev",
        dependencies: [],
        acceptance: [],
        artifacts: []
      }
    ]
  } as any;
  const runtime = {
    tasks: [
      {
        taskId: "task-a",
        state: "READY",
        lastSummary: "pending",
        lastTransitionAt: "2026-03-28T12:00:00.000Z"
      }
    ]
  } as any;

  const service = new WorkflowReminderService({
    repositories: {
      runInUnitOfWork: async (_scope: unknown, operation: () => Promise<void>) => await operation(),
      inbox: {
        appendInboxMessage: async (_runId: string, role: string, message: Record<string, unknown>) => {
          inboxMessages.push({ role, message });
        }
      },
      events: {
        appendEvent: async (_runId: string, event: Record<string, unknown>) => {
          appendedEvents.push(event);
        }
      },
      reminders: {
        getRoleReminderState: async (_runId: string, role: string) => reminderStates.get(role) ?? null,
        updateRoleReminderState: async (_runId: string, role: string, patch: Record<string, unknown>) => {
          const next = {
            role,
            reminderCount: 0,
            ...reminderStates.get(role),
            ...patch
          };
          reminderStates.set(role, next);
          return next;
        }
      }
    } as any,
    idleReminderMs: 60_000,
    reminderBackoffMultiplier: 2,
    reminderMaxIntervalMs: 1_800_000,
    reminderMaxCount: 5,
    autoReminderEnabled: true,
    resolveAuthoritativeSession: async () => idleSession as any,
    dispatchRun: async (_runId: string, input: Record<string, unknown>) => {
      dispatchCalls.push(input);
      return {
        results: [{ outcome: "no_message" }]
      };
    }
  });

  reminderStates.set("dev", {
    role: "dev",
    idleSince: "2000-01-01T00:00:00.000Z",
    reminderCount: 0,
    nextReminderAt: "2000-01-01T00:00:00.000Z",
    lastRoleState: "IDLE"
  });

  await service.checkRoleReminders(run, runtime, [idleSession as any]);

  assert.equal(inboxMessages.length, 1);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(
    appendedEvents.some((event) => event.eventType === "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED"),
    true
  );
  assert.equal(
    appendedEvents.some((event) => event.eventType === "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH"),
    true
  );
});
