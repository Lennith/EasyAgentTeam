import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  getWorkflowRun,
  patchWorkflowRun
} from "../data/repository/workflow/run-repository.js";
import { listWorkflowSessions, upsertWorkflowSession } from "../data/repository/workflow/runtime-repository.js";
import { createWorkflowOrchestratorService } from "../services/orchestrator/index.js";
import { createProviderRegistry } from "../services/provider-runtime.js";

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
    const sessionDir = path.join(tempRoot, ".minimax", "sessions", "wf_timeout_s_lead");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "latest_llm_input_messages.json"),
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        stage: "initial",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" }
        ]
      }),
      "utf-8"
    );

    const run = await getWorkflowRun(tempRoot, "wf_timeout_run");
    assert.ok(run);
    const sessionsBefore = await listWorkflowSessions(tempRoot, "wf_timeout_run");
    assert.equal(sessionsBefore[0]?.status, "running");

    await new Promise((resolve) => setTimeout(resolve, 10));
    const orchestrator = createWorkflowOrchestratorService(tempRoot, createProviderRegistry()) as unknown as {
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

    const timeoutDumpFiles = (await readdir(sessionDir)).filter((name) => name.startsWith("timeout_error_"));
    assert.equal(timeoutDumpFiles.length, 1);
    const timeoutDump = JSON.parse(await readFile(path.join(sessionDir, timeoutDumpFiles[0]), "utf-8")) as {
      source: string;
      messageCount: number;
      messages: Array<{ role: string; content: string }>;
      analysis?: {
        topMessages?: Array<{ index: number; role: string; toolName: string | null; chars: number; preview: string }>;
        roleCharShare?: Record<string, { chars: number; pct: number }>;
        toolCharShare?: Record<string, { chars: number; pct: number }>;
        fattestTool?: { toolName: string; chars: number; pct: number } | null;
        totalChars?: number;
        toolChars?: number;
        toolCharPct?: number;
      };
    };
    assert.equal(timeoutDump.source, "latest_llm_input_messages");
    assert.equal(timeoutDump.messageCount, 3);
    assert.equal(timeoutDump.messages[1]?.content, "u1");
    assert.ok(timeoutDump.analysis);
    assert.equal(Array.isArray(timeoutDump.analysis?.topMessages), true);
    assert.equal((timeoutDump.analysis?.topMessages?.length ?? 0) > 0, true);
    assert.equal(typeof timeoutDump.analysis?.roleCharShare?.user?.pct, "number");
    assert.deepEqual(timeoutDump.analysis?.toolCharShare, {});
    assert.equal(timeoutDump.analysis?.fattestTool ?? null, null);
    assert.equal(typeof timeoutDump.analysis?.totalChars, "number");
    assert.equal(timeoutDump.analysis?.toolChars, 0);
    assert.equal(timeoutDump.analysis?.toolCharPct, 0);
  } finally {
    if (prevTimeout === undefined) delete process.env.WORKFLOW_SESSION_RUNNING_TIMEOUT_MS;
    else process.env.WORKFLOW_SESSION_RUNNING_TIMEOUT_MS = prevTimeout;
    if (prevThreshold === undefined) delete process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
    else process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = prevThreshold;
    if (prevCooldown === undefined) delete process.env.SESSION_TIMEOUT_COOLDOWN_MS;
    else process.env.SESSION_TIMEOUT_COOLDOWN_MS = prevCooldown;
  }
});
