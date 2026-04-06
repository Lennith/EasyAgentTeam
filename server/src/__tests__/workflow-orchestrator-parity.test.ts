import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  getWorkflowRun,
  patchWorkflowRun
} from "../data/repository/workflow/run-repository.js";
import {
  appendWorkflowRunEvent,
  listWorkflowRunEvents,
  listWorkflowSessions,
  upsertWorkflowSession
} from "../data/repository/workflow/runtime-repository.js";
import { createWorkflowOrchestratorService } from "../services/orchestrator/index.js";
import { createProviderRegistry } from "../services/provider-runtime.js";

test("workflow resolves role-authoritative session with persisted roleSessionMap", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-role-authority-"));
  const runId = "wf_role_authority_run";
  await createWorkflowTemplate(tempRoot, {
    templateId: "wf_role_authority_tpl",
    name: "Workflow Role Authority Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId,
    templateId: "wf_role_authority_tpl",
    name: "Workflow Role Authority Run",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }]
  });
  await patchWorkflowRun(tempRoot, runId, {
    status: "running",
    roleSessionMap: { lead: "ghost-session" }
  });
  await upsertWorkflowSession(tempRoot, runId, {
    sessionId: "lead-session-01",
    role: "lead",
    status: "idle"
  });
  await upsertWorkflowSession(tempRoot, runId, {
    sessionId: "lead-session-02",
    role: "lead",
    status: "idle"
  });

  const orchestrator = createWorkflowOrchestratorService(tempRoot, createProviderRegistry());
  await orchestrator.sendRunMessage({
    runId,
    fromAgent: "manager",
    fromSessionId: "manager-system",
    messageType: "MANAGER_MESSAGE",
    toRole: "lead",
    taskId: "task_a",
    content: "continue task_a"
  });

  const sessions = await listWorkflowSessions(tempRoot, runId);
  const activeLeadSessions = sessions.filter((session) => session.role === "lead" && session.status !== "dismissed");
  assert.equal(activeLeadSessions.length, 1);
  const authoritativeSessionId = activeLeadSessions[0]?.sessionId;
  assert.equal(typeof authoritativeSessionId, "string");

  const runAfter = await getWorkflowRun(tempRoot, runId);
  assert.ok(runAfter);
  assert.equal(runAfter?.roleSessionMap?.lead, authoritativeSessionId);

  const events = await listWorkflowRunEvents(tempRoot, runId);
  assert.equal(
    events.some((event) => event.eventType === "ROLE_SESSION_CONFLICT_DETECTED"),
    true
  );
  assert.equal(
    events.some((event) => event.eventType === "ROLE_SESSION_CONFLICT_RESOLVED"),
    true
  );
});

test("workflow dispatch skips duplicate open task dispatch", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-duplicate-dispatch-"));
  const runId = "wf_duplicate_dispatch_run";
  await createWorkflowTemplate(tempRoot, {
    templateId: "wf_duplicate_dispatch_tpl",
    name: "Workflow Duplicate Dispatch Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId,
    templateId: "wf_duplicate_dispatch_tpl",
    name: "Workflow Duplicate Dispatch Run",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }]
  });
  const orchestrator = createWorkflowOrchestratorService(tempRoot, createProviderRegistry());
  await orchestrator.startRun(runId);
  await upsertWorkflowSession(tempRoot, runId, {
    sessionId: "lead-session-01",
    role: "lead",
    status: "idle"
  });
  await appendWorkflowRunEvent(tempRoot, runId, {
    eventType: "ORCHESTRATOR_DISPATCH_STARTED",
    source: "system",
    sessionId: "lead-session-01",
    taskId: "task_a",
    payload: {
      dispatchId: "dispatch-open-01",
      dispatchKind: "task",
      requestId: "request-open-01"
    }
  });

  const result = await orchestrator.dispatchRun(runId, {
    source: "manual",
    role: "lead",
    taskId: "task_a",
    force: false,
    onlyIdle: true,
    maxDispatches: 1
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.outcome, "already_dispatched");
  assert.equal(result.results[0]?.reason, "duplicate_open_dispatch");

  const events = await listWorkflowRunEvents(tempRoot, runId);
  const skipEvent = events.find(
    (event) =>
      event.eventType === "ORCHESTRATOR_DISPATCH_SKIPPED" &&
      event.sessionId === "lead-session-01" &&
      event.taskId === "task_a"
  );
  assert.ok(skipEvent);
  assert.equal((skipEvent?.payload as Record<string, unknown>).dispatchSkipReason, "duplicate_open_dispatch");

  const startedCount = events.filter(
    (event) =>
      event.eventType === "ORCHESTRATOR_DISPATCH_STARTED" &&
      event.sessionId === "lead-session-01" &&
      event.taskId === "task_a"
  ).length;
  assert.equal(startedCount, 1);
});
