import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs, { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

function createErrnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function createWorkflowRun(baseUrl: string, runId: string, workspaceRoot: string): Promise<void> {
  const templateResp = await fetch(`${baseUrl}/api/workflow-templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      template_id: `tpl_${runId}`,
      name: "Timeline Storage Resilience Template",
      tasks: [{ task_id: "task_a", title: "Task A", owner_role: "lead" }]
    })
  });
  assert.equal(templateResp.status, 201);

  const runResp = await fetch(`${baseUrl}/api/workflow-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      template_id: `tpl_${runId}`,
      run_id: runId,
      workspace_path: workspaceRoot
    })
  });
  assert.equal(runResp.status, 201);
}

async function seedWalRecord(dataRoot: string, runId: string, txId: string): Promise<string> {
  const walDir = path.join(dataRoot, "workflows", "runs", runId, ".storage-wal");
  const walFile = path.join(walDir, `${txId}.wal.json`);
  await mkdir(walDir, { recursive: true });
  await writeFile(
    walFile,
    `${JSON.stringify(
      {
        schemaVersion: "1.0",
        txId,
        state: "committed",
        preparedAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
        operations: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return walFile;
}

test("workflow agent-io timeline survives transient wal EPERM and keeps 200", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-wf-timeline-wal-retry-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const runId = "wf_timeline_retry_run";
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  const originalReadFile = fs.readFile;
  try {
    await createWorkflowRun(baseUrl, runId, workspaceRoot);
    const walFile = await seedWalRecord(dataRoot, runId, "tx-retry");

    let remainingFailures = 2;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      const target = String(args[0]);
      if (target === walFile && remainingFailures > 0) {
        remainingFailures -= 1;
        throw createErrnoError("EPERM", "simulated transient wal read failure");
      }
      return originalReadFile(...args);
    }) as typeof fs.readFile;

    const timelineResp = await fetch(`${baseUrl}/api/workflow-runs/${runId}/agent-io/timeline?limit=1000`);
    assert.equal(timelineResp.status, 200);
    const payload = (await timelineResp.json()) as { items?: unknown[]; total?: number };
    assert.equal(Array.isArray(payload.items), true);
    assert.equal(typeof payload.total, "number");
    assert.equal(remainingFailures, 0);
  } finally {
    fs.readFile = originalReadFile;
    await serverHandle.close();
  }
});

test("workflow agent-io timeline returns 503 when wal read stays EPERM", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-wf-timeline-wal-503-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const runId = "wf_timeline_fail_run";
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  const originalReadFile = fs.readFile;
  try {
    await createWorkflowRun(baseUrl, runId, workspaceRoot);
    const walFile = await seedWalRecord(dataRoot, runId, "tx-fail");

    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      const target = String(args[0]);
      if (target === walFile) {
        throw createErrnoError("EPERM", "simulated persistent wal read failure");
      }
      return originalReadFile(...args);
    }) as typeof fs.readFile;

    const timelineResp = await fetch(`${baseUrl}/api/workflow-runs/${runId}/agent-io/timeline?limit=1000`);
    assert.equal(timelineResp.status, 503);
    const payload = (await timelineResp.json()) as {
      error_code?: string;
      error?: { details?: Record<string, unknown> };
      message?: string;
    };
    assert.equal(payload.error_code, "STORAGE_TEMPORARILY_UNAVAILABLE");
    assert.equal(String(payload.error?.details?.operation), "readFile");
    assert.equal(String(payload.error?.details?.errorCode), "EPERM");
    assert.equal(String(payload.error?.details?.walFile), path.resolve(walFile));
    assert.equal(String(payload.error?.details?.runId), runId);
    assert.equal(Boolean(payload.message?.includes("WAL readFile failed")), true);
  } finally {
    fs.readFile = originalReadFile;
    await serverHandle.close();
  }
});
