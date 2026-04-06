import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentTimelineFromEvents } from "../services/agent-io-timeline-core.js";

test("agent io timeline core preserves dispatch metadata split between project and workflow", () => {
  const events = [
    {
      eventId: "evt-start",
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        requestId: "req-1",
        messageId: "msg-1",
        requestedSkillIds: ["skill.alpha", "skill.beta"]
      }
    },
    {
      eventId: "evt-fail",
      eventType: "ORCHESTRATOR_DISPATCH_FAILED",
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        requestId: "req-1",
        messageId: "msg-1",
        error: "dispatch_failed",
        requestedSkillIds: ["skill.alpha", "skill.beta"]
      }
    },
    {
      eventId: "evt-finish",
      eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: {
        requestId: "req-1",
        messageId: "msg-1",
        runId: "run-1",
        timedOut: false,
        requestedSkillIds: ["skill.alpha", "skill.beta"]
      }
    }
  ];

  const projectTimeline = buildAgentTimelineFromEvents(events);
  const workflowTimeline = buildAgentTimelineFromEvents(events, {
    includeRequestedSkillIds: true
  });

  assert.equal(projectTimeline.items[0]?.content, undefined);
  assert.equal(projectTimeline.items[1]?.content, undefined);
  assert.equal(projectTimeline.items[2]?.content, undefined);

  assert.equal(workflowTimeline.items[0]?.content, "requestedSkillIds=skill.alpha,skill.beta");
  assert.equal(workflowTimeline.items[1]?.content, "dispatch_failed | requestedSkillIds=skill.alpha,skill.beta");
  assert.equal(workflowTimeline.items[2]?.content, "requestedSkillIds=skill.alpha,skill.beta");
});

test("agent io timeline core maps discuss routes and respects limit", () => {
  const timeline = buildAgentTimelineFromEvents(
    [
      {
        eventId: "evt-1",
        eventType: "USER_MESSAGE_RECEIVED",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: {
          requestId: "req-a",
          content: "hello",
          sourceType: "manager",
          fromAgent: "manager"
        }
      },
      {
        eventId: "evt-2",
        eventType: "MESSAGE_ROUTED",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {
          requestId: "req-b",
          messageId: "msg-b",
          content: "reply",
          messageType: "TASK_DISCUSS_REQUEST",
          discuss: {
            thread_id: "thread-1"
          }
        }
      }
    ],
    { limit: 1 }
  );

  assert.equal(timeline.total, 2);
  assert.equal(timeline.items.length, 1);
  assert.equal(timeline.items[0]?.kind, "task_discuss");
  assert.equal(timeline.items[0]?.discussThreadId, "thread-1");
});
