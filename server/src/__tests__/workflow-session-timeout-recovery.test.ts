import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createWorkflowRun, createWorkflowTemplate, getWorkflowRun, patchWorkflowRun } from "../data/workflow-store.js";
import { listWorkflowSessions, upsertWorkflowSession } from "../data/workflow-run-store.js";
import { createWorkflowOrchestratorService } from "../services/workflow-orchestrator-service.js";

test("workflow timeout uses soft recovery (idle) before escalation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-timeout-recovery-"));

  const prevTimeout = process.env.WORKFLOW_SESSION_RUNNING_TIMEOUT_MS;
  const prevThreshold = process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
  const prevCooldown = process.env.SESSION_TIMEOUT_COOLDOWN_MS;

  process.env.WORKFLOW_SESSION_RUNNING_TIMEOUT_MS = "1";
  process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = "3";
  process.env.SESSION_TIMEOUT_COOLDOWN_MS = "0";

  try {
    await createWorkflowTemplate(tempRoot, {
      templateId: "wf_timeout_tpl",
      name: "Workflow Timeout Template",
      tasks: [{ taskId: "wf_phase_a", title: "Phase A", ownerRole: "lead" }]
    });

    await createWorkflowRun(tempRoot, {
      runId: "wf_timeout_run",
      templateId: "wf_timeout_tpl",
      name: "Workflow Timeout Run",
      workspacePath: tempRoot,
      tasks: [{ taskId: "wf_phase_a", title: "Phase A", ownerRole: "lead", resolvedTitle: "Phase A" }]
    });
    await patchWorkflowRun(tempRoot, "wf_timeout_run", { status: "running" });

    await upsertWorkflowSession(tempRoot, "wf_timeout_run", {
      sessionId: "wf_timeout_s_lead",
      role: "lead",
      status: "running",
      provider: "minimax"
    });

    const run = await getWorkflowRun(tempRoot, "wf_timeout_run");
    assert.ok(run);
    const sessionsBefore = await listWorkflowSessions(tempRoot, "wf_timeout_run");
    assert.equal(sessionsBefore[0]?.status, "running");

    await new Promise((resolve) => setTimeout(resolve, 10));
    const orchestrator = createWorkflowOrchestratorService(tempRoot) as unknown as {
      markTimedOutSessions: (
        runRecord: NonNullable<typeof run>,
        sessions: Awaited<ReturnType<typeof listWorkflowSessions>>
      ) => Promise<void>;
    };
    await orchestrator.markTimedOutSessions(run, sessionsBefore);

    const sessionsAfter = await listWorkflowSessions(tempRoot, "wf_timeout_run");
    const session = sessionsAfter.find((item) => item.sessionId === "wf_timeout_s_lead");
    assert.ok(session);
    assert.equal(session.status, "idle");
    assert.equal(session.timeoutStreak, 1);
    assert.equal(session.lastFailureKind, "timeout");
  } finally {
    if (prevTimeout === undefined) delete process.env.WORKFLOW_SESSION_RUNNING_TIMEOUT_MS;
    else process.env.WORKFLOW_SESSION_RUNNING_TIMEOUT_MS = prevTimeout;
    if (prevThreshold === undefined) delete process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
    else process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = prevThreshold;
    if (prevCooldown === undefined) delete process.env.SESSION_TIMEOUT_COOLDOWN_MS;
    else process.env.SESSION_TIMEOUT_COOLDOWN_MS = prevCooldown;
  }
});
