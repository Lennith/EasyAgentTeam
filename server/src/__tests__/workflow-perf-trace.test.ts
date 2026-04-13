import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isWorkflowPerfTraceEnabled, traceWorkflowPerfSpan } from "../services/workflow-perf-trace.js";

async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "workflow-perf-trace-"));
}

test("workflow perf trace is disabled by default", async () => {
  delete process.env.WORKFLOW_PERF_TRACE;
  const tempRoot = await makeTempRoot();
  const result = await traceWorkflowPerfSpan(
    {
      dataRoot: tempRoot,
      runId: "run-disabled",
      scope: "service",
      name: "dispatchRun"
    },
    async () => "ok"
  );

  assert.equal(isWorkflowPerfTraceEnabled(), false);
  assert.equal(result, "ok");
  await assert.rejects(
    fs.access(path.join(tempRoot, "workflows", "runs", "run-disabled", "audit", "perf_trace.jsonl"))
  );
});

test("workflow perf trace appends jsonl when enabled", async () => {
  process.env.WORKFLOW_PERF_TRACE = "1";
  const tempRoot = await makeTempRoot();

  const result = await traceWorkflowPerfSpan(
    {
      dataRoot: tempRoot,
      runId: "run-enabled",
      scope: "route",
      name: "GET /api/workflow-runs/:run_id/task-runtime",
      details: { method: "GET" }
    },
    async () => ({ ok: true })
  );

  assert.deepEqual(result, { ok: true });
  const tracePath = path.join(tempRoot, "workflows", "runs", "run-enabled", "audit", "perf_trace.jsonl");
  const raw = await fs.readFile(tracePath, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(entry.runId, "run-enabled");
  assert.equal(entry.scope, "route");
  assert.equal(entry.name, "GET /api/workflow-runs/:run_id/task-runtime");
  assert.equal(entry.ok, true);
  assert.equal(typeof entry.elapsedMs, "number");
  assert.deepEqual(entry.details, { method: "GET" });
});

test("workflow perf trace records failure and rethrows", async () => {
  process.env.WORKFLOW_PERF_TRACE = "true";
  const tempRoot = await makeTempRoot();

  await assert.rejects(
    traceWorkflowPerfSpan(
      {
        dataRoot: tempRoot,
        runId: "run-error",
        scope: "repo",
        name: "workflowRuns.patchRun"
      },
      async () => {
        throw new Error("boom");
      }
    ),
    /boom/
  );

  const tracePath = path.join(tempRoot, "workflows", "runs", "run-error", "audit", "perf_trace.jsonl");
  const raw = await fs.readFile(tracePath, "utf8");
  const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
  assert.equal(entry.ok, false);
  assert.equal(entry.error, "boom");
});
