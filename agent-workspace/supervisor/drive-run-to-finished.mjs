#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentWorkspaceError } from "../src/errors.mjs";
import { requestJson } from "../src/utils/http-client.mjs";
import {
  checkArtifactsExistence,
  classifyRoundOutcome,
  loadRunEventsFromDataRoot,
  summarizeEventEvidence,
  summarizeRuntimeStatus
} from "./real-supervisor-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function ensureArg(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new AgentWorkspaceError(`missing required argument: --${name}`, "SUPERVISOR_CLI_INPUT_INVALID");
  }
  return text;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toTaskId(task) {
  return String(task?.taskId ?? task?.task_id ?? "").trim();
}

function toOwnerRole(task) {
  return String(task?.ownerRole ?? task?.owner_role ?? "").trim();
}

function toDependencies(task) {
  return Array.isArray(task?.dependencies) ? task.dependencies.map((item) => String(item).trim()).filter(Boolean) : [];
}

function topologicalTemplateTasks(tasks) {
  const templateTasks = (Array.isArray(tasks) ? tasks : []).filter((task) => !task?.creatorRole && !task?.creator_role);
  const byId = new Map(templateTasks.map((task) => [toTaskId(task), task]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(taskId) {
    if (!taskId || visited.has(taskId)) {
      return;
    }
    if (visiting.has(taskId)) {
      throw new AgentWorkspaceError(`workflow dependency cycle at '${taskId}'`, "SUPERVISOR_TASK_CYCLE");
    }
    visiting.add(taskId);
    const task = byId.get(taskId);
    if (task) {
      for (const depId of toDependencies(task)) {
        if (byId.has(depId)) {
          visit(depId);
        }
      }
      ordered.push(task);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of templateTasks) {
    visit(toTaskId(task));
  }
  return ordered;
}

function findTaskState(runtimePayload, taskId) {
  const tasks = Array.isArray(runtimePayload?.tasks) ? runtimePayload.tasks : [];
  const task = tasks.find((item) => toTaskId(item) === taskId);
  return String(task?.state ?? "").toUpperCase();
}

async function ensureRoleSession(baseUrl, runId, role) {
  const body = {
    role,
    session_id: `drive-${runId}-${role}`
  };
  try {
    await requestJson(baseUrl, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/sessions`, body, [200, 201, 409]);
  } catch (error) {
    if (error instanceof AgentWorkspaceError && error.code === "HTTP_REQUEST_FAILED" && error.details?.status === 409) {
      return;
    }
    throw error;
  }
}

function buildManagerMessage(task) {
  const taskId = toTaskId(task);
  const role = toOwnerRole(task);
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
  const artifactLines = artifacts.map((item) => `- ${String(item)}`).join("\n");
  return [
    `Focus task: ${taskId}`,
    `Owner role: ${role}`,
    "",
    "Hard requirements:",
    "1) Do NOT create subtasks and do NOT call task_create_assign.",
    "2) Produce concrete files exactly at these artifact paths (relative to TeamWorkSpace root):",
    artifactLines || "- (no artifacts declared)",
    `3) After files are created, report DONE only for task '${taskId}'.`,
    "4) Keep output concise and execution-oriented; avoid long planning prose.",
    "5) Do not scan unrelated folders or historical documents; only touch files needed by this task.",
    "6) Keep final report compact (short checklist + file list), do not dump full document bodies."
  ].join("\n");
}

async function dispatchTaskDrive(baseUrl, runId, task) {
  const role = toOwnerRole(task);
  const message = buildManagerMessage(task);
  await requestJson(
    baseUrl,
    "POST",
    `/api/workflow-runs/${encodeURIComponent(runId)}/messages/send`,
    {
      from_agent: "manager",
      from_session_id: "manager-system",
      to_role: role,
      content: message
    },
    [200]
  );
  await requestJson(
    baseUrl,
    "POST",
    `/api/workflow-runs/${encodeURIComponent(runId)}/orchestrator/dispatch`,
    {
      role,
      force: true,
      only_idle: false
    },
    [200]
  );
}

async function waitTaskState(baseUrl, runId, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtimePayload = await requestJson(
      baseUrl,
      "GET",
      `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`,
      undefined,
      [200]
    );
    const state = findTaskState(runtimePayload, taskId);
    if (state === "DONE" || state === "FAILED" || state === "BLOCKED" || state === "BLOCKED_DEP") {
      return { state, runtimePayload };
    }
    await sleep(8000);
  }
  const runtimePayload = await requestJson(
    baseUrl,
    "GET",
    `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`,
    undefined,
    [200]
  );
  return {
    state: findTaskState(runtimePayload, taskId),
    runtimePayload
  };
}

async function waitTaskReadyOrDone(baseUrl, runId, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtimePayload = await requestJson(
      baseUrl,
      "GET",
      `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`,
      undefined,
      [200]
    );
    const state = findTaskState(runtimePayload, taskId);
    if (state === "READY" || state === "DONE" || state === "IN_PROGRESS") {
      return { state, runtimePayload };
    }
    await sleep(5000);
  }
  const runtimePayload = await requestJson(
    baseUrl,
    "GET",
    `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`,
    undefined,
    [200]
  );
  return {
    state: findTaskState(runtimePayload, taskId),
    runtimePayload
  };
}

async function waitRunFinished(baseUrl, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusPayload = await requestJson(
      baseUrl,
      "GET",
      `/api/workflow-runs/${encodeURIComponent(runId)}/status`,
      undefined,
      [200]
    );
    const status = String(statusPayload?.status ?? "").toLowerCase();
    if (status === "finished" || status === "failed" || status === "stopped") {
      return statusPayload;
    }
    await sleep(8000);
  }
  return requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/status`, undefined, [200]);
}

async function writeReport(outputRoot, payload) {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(outputRoot, "drive_report.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = ensureArg(args["base-url"], "base-url");
  const runId = ensureArg(args["run-id"], "run-id");
  const dataRoot = typeof args["data-root"] === "string" ? path.resolve(args["data-root"]) : path.resolve(repoRoot, "data");
  const maxTaskAttempts = Number.isFinite(Number(args["max-attempts"])) ? Number(args["max-attempts"]) : 4;
  const waitReadyMs = Number.isFinite(Number(args["wait-ready-ms"])) ? Number(args["wait-ready-ms"]) : 180000;
  const waitTaskMs = Number.isFinite(Number(args["wait-task-ms"])) ? Number(args["wait-task-ms"]) : 240000;
  const waitRunMs = Number.isFinite(Number(args["wait-run-ms"])) ? Number(args["wait-run-ms"]) : 300000;
  const outputRoot =
    typeof args["output-root"] === "string"
      ? path.resolve(args["output-root"])
      : path.resolve(repoRoot, "agent-workspace", "reports", "drive-run", `${runId}-${nowStamp()}`);

  await requestJson(baseUrl, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/start`, {}, [200]);
  await requestJson(
    baseUrl,
    "PATCH",
    `/api/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`,
    {
      auto_dispatch_enabled: false,
      auto_dispatch_remaining: 0,
      reminder_mode: "backoff"
    },
    [200]
  );

  const runDetailBefore = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`, undefined, [200]);
  const orderedTasks = topologicalTemplateTasks(runDetailBefore.tasks);
  const taskAttempts = [];

  for (const task of orderedTasks) {
    const taskId = toTaskId(task);
    const role = toOwnerRole(task);
    await ensureRoleSession(baseUrl, runId, role);

    const readyState = await waitTaskReadyOrDone(baseUrl, runId, taskId, waitReadyMs);
    if (readyState.state === "DONE") {
      taskAttempts.push({ task_id: taskId, role, attempts: 0, outcome: "already_done", final_state: "DONE" });
      continue;
    }

    let done = false;
    let finalState = readyState.state;
    let attempts = 0;
    while (attempts < maxTaskAttempts && !done) {
      attempts += 1;
      await dispatchTaskDrive(baseUrl, runId, task);
      const waited = await waitTaskState(baseUrl, runId, taskId, waitTaskMs);
      finalState = waited.state;
      if (finalState === "DONE") {
        done = true;
      }
    }

    taskAttempts.push({
      task_id: taskId,
      role,
      attempts,
      final_state: finalState,
      outcome: finalState === "DONE" ? "done" : "not_done"
    });
  }

  const statusPayload = await waitRunFinished(baseUrl, runId, waitRunMs);
  const runtimePayload = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`, undefined, [
    200
  ]);
  const runDetailAfter = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`, undefined, [200]);
  const loadedEvents = await loadRunEventsFromDataRoot(dataRoot, runId);
  const eventEvidence = summarizeEventEvidence(loadedEvents.events);
  const runtimeSummary = summarizeRuntimeStatus(statusPayload, runtimePayload);
  const artifactCheck = await checkArtifactsExistence(runDetailAfter.tasks ?? [], String(runDetailAfter.workspacePath ?? ""));
  const judged = classifyRoundOutcome({
    eventEvidence,
    runtimeSummary,
    artifactCheck
  });

  const report = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    base_url: baseUrl,
    data_root: dataRoot,
    output_root: outputRoot,
    task_attempts: taskAttempts,
    status_payload: statusPayload,
    runtime_summary: runtimeSummary,
    event_evidence: {
      ...eventEvidence,
      events_path: loadedEvents.events_path
    },
    artifact_check: artifactCheck,
    judgment: judged
  };

  await writeReport(outputRoot, report);
  console.log(`[drive-run] run_id=${runId}`);
  console.log(`[drive-run] output=${outputRoot}`);
  console.log(`[drive-run] status=${statusPayload.status} done=${runtimeSummary.done_tasks}/${runtimeSummary.total_tasks}`);
  console.log(`[drive-run] judgment=${judged.status}/${judged.category}`);

  if (String(statusPayload?.status ?? "").toLowerCase() !== "finished") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[drive-run] error: ${message}`);
  if (error && typeof error === "object" && "details" in error && error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});
