import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { touchWorkflowSession } from "../data/repository/workflow/runtime-repository.js";
import { patchWorkflowRun } from "../data/repository/workflow/run-repository.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

async function writeTriggerPlugin(
  root: string,
  input: { pluginId: string; name: string; entry?: string; source: string }
): Promise<string> {
  const pluginDir = path.join(root, input.pluginId);
  await mkdir(pluginDir, { recursive: true });
  const entry = input.entry ?? "index.mjs";
  await writeFile(
    path.join(pluginDir, "trigger.plugin.yaml"),
    ['schema_version: "1.0"', `plugin_id: ${input.pluginId}`, `name: ${input.name}`, `entry: ${entry}`, ""].join("\n"),
    "utf8"
  );
  await writeFile(path.join(pluginDir, entry), input.source, "utf8");
  return pluginDir;
}

async function createSimpleWorkflow(baseUrl: string, workspaceRoot: string): Promise<void> {
  const fetch = globalThis.fetch;
  const createTemplate = await fetch(`${baseUrl}/api/workflow-templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      template_id: "trigger_hello_template",
      name: "Trigger Hello Template",
      default_variables: { message: "default hello" },
      tasks: [{ task_id: "say_hello", title: "Say {{message}}", owner_role: "lead" }]
    })
  });
  assert.equal(createTemplate.status, 201);
  await mkdir(workspaceRoot, { recursive: true });
}

test("trigger plugin import and manual test can create a workflow run", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-trigger-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const pluginRoot = path.join(tempRoot, "plugins");
  const pluginDir = await writeTriggerPlugin(pluginRoot, {
    pluginId: "hello-trigger",
    name: "Hello Trigger",
    source: `
export async function doCheck(ctx) {
  return { need_trigger: true, reason: "hello", payload: { message: "hello-" + ctx.trigger.trigger_id } };
}

export async function onCheckResult(ctx, result) {
  return {
    should_trigger: true,
    reason: result.reason,
    variables: { message: result.payload.message },
    run_name: "hello trigger run"
  };
}

export async function onWorkflowCompleted(_ctx, completion) {
  return { accepted: completion.status === "finished", summary: completion.status };
}
`
  });

  const app = createApp({ dataRoot, autoStartLoops: false });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;
  const fetch = globalThis.fetch;

  try {
    await createSimpleWorkflow(baseUrl, workspaceRoot);
    const createAgent = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "lead",
        display_name: "Lead",
        prompt: "Handle the trigger workflow task.",
        provider_id: "dpagent",
        default_model_params: { model: "dpagent-config" }
      })
    });
    assert.equal(createAgent.status, 201);

    const importPlugin = await fetch(`${baseUrl}/api/trigger-plugins/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: pluginDir })
    });
    assert.equal(importPlugin.status, 200);
    const importPayload = (await importPlugin.json()) as { plugin: { pluginId: string; name: string } };
    assert.equal(importPayload.plugin.pluginId, "hello-trigger");

    const createTrigger = await fetch(`${baseUrl}/api/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger_id: "hello_every_30",
        plugin_id: "hello-trigger",
        enabled: true,
        interval_seconds: 30,
        workflow_template_id: "trigger_hello_template",
        workspace_path: workspaceRoot,
        hook_timeout_ms: 5000
      })
    });
    assert.equal(createTrigger.status, 201);

    const manualTest = await fetch(`${baseUrl}/api/triggers/hello_every_30/test`, { method: "POST" });
    assert.equal(manualTest.status, 200);
    const testPayload = (await manualTest.json()) as {
      status: string;
      fireId: string;
      workflowRunId?: string;
    };
    assert.equal(testPayload.status, "fired");
    assert.equal(typeof testPayload.fireId, "string");
    assert.equal(typeof testPayload.workflowRunId, "string");

    const run = await fetch(`${baseUrl}/api/workflow-runs/${testPayload.workflowRunId}`);
    assert.equal(run.status, 200);
    const runPayload = (await run.json()) as {
      runId: string;
      templateId: string;
      status: string;
      variables?: Record<string, string>;
      tasks: Array<{ taskId: string; resolvedTitle: string }>;
    };
    assert.equal(runPayload.templateId, "trigger_hello_template");
    assert.equal(runPayload.status, "running");
    assert.equal(runPayload.variables?.message, "hello-hello_every_30");
    assert.equal(runPayload.tasks[0]?.resolvedTitle, "Say hello-hello_every_30");

    const sessions = await fetch(`${baseUrl}/api/workflow-runs/${testPayload.workflowRunId}/sessions`);
    assert.equal(sessions.status, 200);
    const sessionsPayload = (await sessions.json()) as {
      items: Array<{ role: string; provider?: string }>;
    };
    assert.equal(sessionsPayload.items.find((item) => item.role === "lead")?.provider, "dpagent");

    const history = await fetch(`${baseUrl}/api/triggers/hello_every_30/runs`);
    assert.equal(history.status, 200);
    const historyPayload = (await history.json()) as {
      total: number;
      items: Array<{ fireId: string; status: string; workflowRunId?: string }>;
    };
    assert.equal(historyPayload.total, 1);
    assert.equal(historyPayload.items[0]?.fireId, testPayload.fireId);
    assert.equal(historyPayload.items[0]?.status, "fired");
    assert.equal(historyPayload.items[0]?.workflowRunId, testPayload.workflowRunId);
  } finally {
    await server.close();
  }
});

test("reuse provider session trigger stores binding, injects it into the next run, and skips while busy", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-trigger-session-reuse-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const pluginRoot = path.join(tempRoot, "plugins");
  const pluginDir = await writeTriggerPlugin(pluginRoot, {
    pluginId: "session-reuse-trigger",
    name: "Session Reuse Trigger",
    source: `
export async function doCheck() {
  return { need_trigger: true, reason: "reuse" };
}

export async function onCheckResult() {
  return { should_trigger: true, reason: "reuse", variables: { message: "reuse" } };
}

export async function onWorkflowCompleted(_ctx, completion) {
  return { accepted: completion.status === "finished", summary: completion.status };
}
`
  });

  const app = createApp({ dataRoot, autoStartLoops: false });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;
  const fetch = globalThis.fetch;
  const providerThreadId = "11111111-1111-4111-8111-111111111111";

  try {
    await createSimpleWorkflow(baseUrl, workspaceRoot);
    const createAgent = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "lead",
        display_name: "Lead",
        prompt: "Handle reuse trigger.",
        provider_id: "dpagent",
        default_model_params: { model: "dpagent-config" }
      })
    });
    assert.equal(createAgent.status, 201);

    const importPlugin = await fetch(`${baseUrl}/api/trigger-plugins/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: pluginDir })
    });
    assert.equal(importPlugin.status, 200);

    const createTrigger = await fetch(`${baseUrl}/api/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger_id: "reuse_every_30",
        plugin_id: "session-reuse-trigger",
        enabled: true,
        interval_seconds: 30,
        workflow_template_id: "trigger_hello_template",
        workspace_path: workspaceRoot,
        hook_timeout_ms: 5000,
        session_mode: "reuse_provider_session"
      })
    });
    assert.equal(createTrigger.status, 201);
    const createdTrigger = (await createTrigger.json()) as { sessionMode: string };
    assert.equal(createdTrigger.sessionMode, "reuse_provider_session");

    const firstTest = await fetch(`${baseUrl}/api/triggers/reuse_every_30/test`, { method: "POST" });
    assert.equal(firstTest.status, 200);
    const firstPayload = (await firstTest.json()) as { status: string; fireId: string; workflowRunId: string };
    assert.equal(firstPayload.status, "fired");

    const firstSessions = await fetch(`${baseUrl}/api/workflow-runs/${firstPayload.workflowRunId}/sessions`);
    assert.equal(firstSessions.status, 200);
    const firstSessionsPayload = (await firstSessions.json()) as {
      items: Array<{ sessionId: string; role: string; provider?: string; providerSessionId?: string }>;
    };
    const firstLead = firstSessionsPayload.items.find((item) => item.role === "lead");
    assert.equal(firstLead?.provider, "dpagent");
    assert.equal(firstLead?.providerSessionId, undefined);

    await touchWorkflowSession(dataRoot, firstPayload.workflowRunId, firstLead?.sessionId ?? "", {
      providerSessionId: providerThreadId
    });
    await patchWorkflowRun(dataRoot, firstPayload.workflowRunId, {
      status: "finished",
      stoppedAt: new Date().toISOString()
    });

    const secondTest = await fetch(`${baseUrl}/api/triggers/reuse_every_30/test`, { method: "POST" });
    assert.equal(secondTest.status, 200);
    const secondPayload = (await secondTest.json()) as { status: string; workflowRunId: string };
    assert.equal(secondPayload.status, "fired");

    const secondSessions = await fetch(`${baseUrl}/api/workflow-runs/${secondPayload.workflowRunId}/sessions`);
    assert.equal(secondSessions.status, 200);
    const secondSessionsPayload = (await secondSessions.json()) as {
      items: Array<{ role: string; providerSessionId?: string }>;
    };
    assert.equal(secondSessionsPayload.items.find((item) => item.role === "lead")?.providerSessionId, providerThreadId);

    const bindingsAfterSecond = await fetch(`${baseUrl}/api/triggers/reuse_every_30/session-bindings`);
    assert.equal(bindingsAfterSecond.status, 200);
    const bindingsAfterSecondPayload = (await bindingsAfterSecond.json()) as {
      items: Array<{ role: string; provider: string; providerSessionId?: string; activeWorkflowRunId?: string }>;
    };
    const leadBinding = bindingsAfterSecondPayload.items.find((item) => item.role === "lead");
    assert.equal(leadBinding?.provider, "dpagent");
    assert.equal(leadBinding?.providerSessionId, providerThreadId);
    assert.equal(leadBinding?.activeWorkflowRunId, secondPayload.workflowRunId);

    const busyTest = await fetch(`${baseUrl}/api/triggers/reuse_every_30/test`, { method: "POST" });
    assert.equal(busyTest.status, 200);
    const busyPayload = (await busyTest.json()) as { status: string; reason?: string };
    assert.equal(busyPayload.status, "skipped");
    assert.match(busyPayload.reason ?? "", /session_binding_busy/);

    const reset = await fetch(`${baseUrl}/api/triggers/reuse_every_30/session-bindings/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(reset.status, 200);
    const resetPayload = (await reset.json()) as { removedCount: number };
    assert.equal(resetPayload.removedCount, 1);

    const bindingsAfterReset = await fetch(`${baseUrl}/api/triggers/reuse_every_30/session-bindings`);
    assert.equal(bindingsAfterReset.status, 200);
    const bindingsAfterResetPayload = (await bindingsAfterReset.json()) as { total: number };
    assert.equal(bindingsAfterResetPayload.total, 0);
  } finally {
    await server.close();
  }
});

test("trigger hook failure is recorded without breaking the API server", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-trigger-hook-failure-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const pluginRoot = path.join(tempRoot, "plugins");
  const pluginDir = await writeTriggerPlugin(pluginRoot, {
    pluginId: "throwing-trigger",
    name: "Throwing Trigger",
    source: `
export async function doCheck() {
  throw new Error("expected hook failure");
}

export async function onCheckResult() {
  return null;
}
`
  });

  const app = createApp({ dataRoot, autoStartLoops: false });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;
  const fetch = globalThis.fetch;

  try {
    await createSimpleWorkflow(baseUrl, workspaceRoot);
    const importPlugin = await fetch(`${baseUrl}/api/trigger-plugins/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: pluginDir })
    });
    assert.equal(importPlugin.status, 200);

    const createTrigger = await fetch(`${baseUrl}/api/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger_id: "throwing_every_30",
        plugin_id: "throwing-trigger",
        enabled: true,
        interval_seconds: 30,
        workflow_template_id: "trigger_hello_template",
        workspace_path: workspaceRoot,
        hook_timeout_ms: 1000
      })
    });
    assert.equal(createTrigger.status, 201);

    const manualTest = await fetch(`${baseUrl}/api/triggers/throwing_every_30/test`, { method: "POST" });
    assert.equal(manualTest.status, 200);
    const testPayload = (await manualTest.json()) as { status: string; error?: string };
    assert.equal(testPayload.status, "failed");
    assert.match(testPayload.error ?? "", /expected hook failure/);

    const listTriggers = await fetch(`${baseUrl}/api/triggers`);
    assert.equal(listTriggers.status, 200);
    const listPayload = (await listTriggers.json()) as { total: number };
    assert.equal(listPayload.total, 1);
  } finally {
    await server.close();
  }
});

test("trigger hook timeout is recorded without blocking the API server", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-trigger-hook-timeout-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const pluginRoot = path.join(tempRoot, "plugins");
  const pluginDir = await writeTriggerPlugin(pluginRoot, {
    pluginId: "timeout-trigger",
    name: "Timeout Trigger",
    source: `
export async function doCheck() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return { need_trigger: true, reason: "too late" };
}

export async function onCheckResult() {
  return { should_trigger: true };
}
`
  });

  const app = createApp({ dataRoot, autoStartLoops: false });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;
  const fetch = globalThis.fetch;

  try {
    await createSimpleWorkflow(baseUrl, workspaceRoot);
    const importPlugin = await fetch(`${baseUrl}/api/trigger-plugins/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: pluginDir })
    });
    assert.equal(importPlugin.status, 200);

    const createTrigger = await fetch(`${baseUrl}/api/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger_id: "timeout_every_30",
        plugin_id: "timeout-trigger",
        enabled: true,
        interval_seconds: 30,
        workflow_template_id: "trigger_hello_template",
        workspace_path: workspaceRoot,
        hook_timeout_ms: 50
      })
    });
    assert.equal(createTrigger.status, 201);

    const manualTest = await fetch(`${baseUrl}/api/triggers/timeout_every_30/test`, { method: "POST" });
    assert.equal(manualTest.status, 200);
    const testPayload = (await manualTest.json()) as { status: string; error?: string };
    assert.equal(testPayload.status, "failed");
    assert.match(testPayload.error ?? "", /timed out/);

    const history = await fetch(`${baseUrl}/api/triggers/timeout_every_30/runs`);
    assert.equal(history.status, 200);
    const historyPayload = (await history.json()) as {
      total: number;
      items: Array<{ status: string; error?: string }>;
    };
    assert.equal(historyPayload.total, 1);
    assert.equal(historyPayload.items[0]?.status, "failed");
    assert.match(historyPayload.items[0]?.error ?? "", /timed out/);

    const listTriggers = await fetch(`${baseUrl}/api/triggers`);
    assert.equal(listTriggers.status, 200);
  } finally {
    await server.close();
  }
});

test("trigger completion hook failure becomes terminal in run history", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-trigger-completion-failure-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const pluginRoot = path.join(tempRoot, "plugins");
  const pluginDir = await writeTriggerPlugin(pluginRoot, {
    pluginId: "bad-completion-trigger",
    name: "Bad Completion Trigger",
    source: `
export async function doCheck() {
  return { need_trigger: true, reason: "complete me" };
}

export async function onCheckResult() {
  return { should_trigger: true, variables: { message: "completion" } };
}

export async function onWorkflowCompleted(ctx) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const file = path.join(ctx.dataDir, "completion-calls.json");
  let count = 0;
  try {
    count = JSON.parse(await fs.readFile(file, "utf8")).count || 0;
  } catch {
    count = 0;
  }
  await fs.writeFile(file, JSON.stringify({ count: count + 1 }), "utf8");
  throw new Error("completion hook failed once");
}
`
  });

  const app = createApp({ dataRoot, autoStartLoops: false });
  const controls = app.locals.runtimeControls as ReturnType<typeof import("../app.js").getAppRuntimeControls>;
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;
  const fetch = globalThis.fetch;

  try {
    await createSimpleWorkflow(baseUrl, workspaceRoot);
    const importPlugin = await fetch(`${baseUrl}/api/trigger-plugins/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: pluginDir })
    });
    assert.equal(importPlugin.status, 200);

    const createTrigger = await fetch(`${baseUrl}/api/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger_id: "bad_completion_every_30",
        plugin_id: "bad-completion-trigger",
        enabled: true,
        interval_seconds: 30,
        workflow_template_id: "trigger_hello_template",
        workspace_path: workspaceRoot,
        hook_timeout_ms: 1000
      })
    });
    assert.equal(createTrigger.status, 201);

    const manualTest = await fetch(`${baseUrl}/api/triggers/bad_completion_every_30/test`, { method: "POST" });
    assert.equal(manualTest.status, 200);
    const testPayload = (await manualTest.json()) as { workflowRunId: string };
    assert.equal(typeof testPayload.workflowRunId, "string");

    await patchWorkflowRun(dataRoot, testPayload.workflowRunId, {
      status: "finished",
      stoppedAt: new Date().toISOString()
    });
    await controls?.triggerRuntime.tickTriggers();
    await controls?.triggerRuntime.tickTriggers();
    const counterPath = path.join(
      dataRoot,
      "triggers",
      "plugin-data",
      "bad-completion-trigger",
      "bad_completion_every_30",
      "completion-calls.json"
    );
    const counter = JSON.parse(await readFile(counterPath, "utf8")) as { count?: number };
    assert.equal(counter.count, 1);

    const history = await fetch(`${baseUrl}/api/triggers/bad_completion_every_30/runs`);
    assert.equal(history.status, 200);
    const historyPayload = (await history.json()) as {
      items: Array<{ status: string; error?: string }>;
    };
    assert.equal(historyPayload.items[0]?.status, "failed");
    assert.match(historyPayload.items[0]?.error ?? "", /completion hook failed once/);
  } finally {
    await server.close();
  }
});
