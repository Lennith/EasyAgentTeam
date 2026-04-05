import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  checkArtifactsExistence,
  classifyRoundOutcome,
  summarizeEventEvidence,
  summarizeRuntimeStatus
} from "../supervisor/real-supervisor-core.mjs";

test("supervisor marks fake_report_path when TASK_REPORT exists without dispatch events", async () => {
  const events = summarizeEventEvidence([
    { eventType: "TASK_ACTION_RECEIVED", createdAt: "2026-04-04T00:00:00.000Z" },
    { eventType: "TASK_REPORT_APPLIED", createdAt: "2026-04-04T00:00:01.000Z" }
  ]);
  const runtime = summarizeRuntimeStatus(
    { status: "finished" },
    { tasks: [{ state: "DONE" }, { state: "DONE" }] }
  );
  const artifacts = {
    workspace_path: "",
    total_artifacts: 0,
    existing_artifacts: 0,
    missing_artifacts: 0,
    items: []
  };
  const judged = classifyRoundOutcome({
    eventEvidence: events,
    runtimeSummary: runtime,
    artifactCheck: artifacts
  });
  assert.equal(judged.status, "fail");
  assert.equal(judged.category, "fake_report_path");
});

test("supervisor passes when dispatch evidence exists, runtime converges, and artifacts exist", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-supervisor-pass-"));
  await fs.mkdir(path.join(workspace, "plan"), { recursive: true });
  await fs.mkdir(path.join(workspace, "exec"), { recursive: true });
  await fs.mkdir(path.join(workspace, "qa"), { recursive: true });
  await fs.writeFile(path.join(workspace, "plan", "summary.md"), "plan", "utf8");
  await fs.writeFile(path.join(workspace, "exec", "result.md"), "result", "utf8");
  await fs.writeFile(path.join(workspace, "qa", "final.md"), "final", "utf8");

  const artifacts = await checkArtifactsExistence(
    [
      { taskId: "t1", artifacts: ["workspace/plan/summary.md"] },
      { taskId: "t2", artifacts: ["workspace/exec/result.md"] },
      { taskId: "t3", artifacts: ["workspace/qa/final.md"] }
    ],
    workspace
  );
  assert.equal(artifacts.missing_artifacts, 0);

  const events = summarizeEventEvidence([
    { eventType: "ORCHESTRATOR_DISPATCH_STARTED", createdAt: "2026-04-04T00:00:00.000Z" },
    { eventType: "ORCHESTRATOR_DISPATCH_FINISHED", createdAt: "2026-04-04T00:00:01.000Z" }
  ]);
  const runtime = summarizeRuntimeStatus(
    { status: "finished" },
    { tasks: [{ state: "DONE" }, { state: "DONE" }, { state: "DONE" }] }
  );
  const judged = classifyRoundOutcome({
    eventEvidence: events,
    runtimeSummary: runtime,
    artifactCheck: artifacts
  });
  assert.equal(judged.status, "pass");
  assert.equal(judged.category, "pass");
});
