#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

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
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`missing --${name}`);
  }
  return normalized;
}

async function requestJson(baseUrl, method, routePath, body = undefined, expectedStatus = [200]) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!expectedStatus.includes(response.status)) {
    throw new Error(`${method} ${routePath} -> ${response.status}: ${text}`);
  }
  return payload;
}

function countTaskStates(tasks) {
  const counts = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const state = String(task?.state || "UNKNOWN").toUpperCase();
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return counts;
}

function toStateObject(counts) {
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function deriveConvergence(runStatus, runtimeTasks) {
  const counts = countTaskStates(runtimeTasks);
  const total = runtimeTasks.length;
  const done = counts.get("DONE") ?? 0;
  const blocked = (counts.get("BLOCKED") ?? 0) + (counts.get("FAILED") ?? 0);
  const converged = total > 0 && done === total && blocked === 0;
  return {
    converged,
    total_tasks: total,
    done_tasks: done,
    blocker_count: blocked,
    run_status: String(runStatus || ""),
    task_states: toStateObject(counts)
  };
}

function toMarkdown(result) {
  const lines = [];
  lines.push(`# Round ${result.round} - ${result.scenario_id}`);
  lines.push("");
  lines.push(`- status: ${result.status}`);
  lines.push(`- converged: ${result.convergence.converged}`);
  lines.push(`- run_id: ${result.run_id}`);
  lines.push(`- run_status: ${result.convergence.run_status}`);
  lines.push(`- blocker_count: ${result.convergence.blocker_count}`);
  lines.push(`- done_tasks: ${result.convergence.done_tasks}/${result.convergence.total_tasks}`);
  lines.push(`- bundle_path: ${result.bundle_path || "n/a"}`);
  lines.push(`- import_report_json: ${result.import_report_json || "n/a"}`);
  lines.push(`- runtime_actions_json: ${result.runtime_actions_json || "n/a"}`);
  lines.push("");
  lines.push("## Task States");
  for (const [state, count] of Object.entries(result.convergence.task_states)) {
    lines.push(`- ${state}: ${count}`);
  }
  if (Object.keys(result.convergence.task_states).length === 0) {
    lines.push("- (none)");
  }
  lines.push("");
  lines.push("## Validate Warnings");
  if ((result.validate_warnings ?? []).length === 0) {
    lines.push("- (none)");
  } else {
    for (const warning of result.validate_warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("");
  return `${lines.join("\n").trim()}\n`;
}

async function readImportWarnings(reportPath) {
  if (!reportPath) {
    return [];
  }
  const content = await fs.readFile(reportPath, "utf8");
  const parsed = JSON.parse(content);
  return Array.isArray(parsed.validation_warnings) ? parsed.validation_warnings : [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = ensureArg(args["base-url"], "base-url");
  const runId = ensureArg(args["run-id"], "run-id");
  const round = ensureArg(args.round, "round");
  const scenarioId = ensureArg(args["scenario-id"], "scenario-id");
  const roundDir = path.resolve(ensureArg(args["round-dir"], "round-dir"));
  const bundlePath = typeof args["bundle-path"] === "string" ? path.resolve(args["bundle-path"]) : "";
  const importReportJson = typeof args["import-report-json"] === "string" ? path.resolve(args["import-report-json"]) : "";
  const runtimeActionsJson =
    typeof args["runtime-actions-json"] === "string" ? path.resolve(args["runtime-actions-json"]) : "";

  const status = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/status`);
  const runtime = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`);
  const warnings = await readImportWarnings(importReportJson);
  const convergence = deriveConvergence(status?.status, Array.isArray(runtime?.tasks) ? runtime.tasks : []);

  const result = {
    time: new Date().toISOString(),
    round: Number(round),
    scenario_id: scenarioId,
    run_id: runId,
    status: convergence.converged ? "pass" : "fail",
    convergence,
    validate_warnings: warnings,
    bundle_path: bundlePath || "",
    import_report_json: importReportJson || "",
    runtime_actions_json: runtimeActionsJson || ""
  };

  await fs.mkdir(roundDir, { recursive: true });
  const resultJson = path.join(roundDir, "round_result.json");
  const resultMd = path.join(roundDir, "round_result.md");
  await fs.writeFile(resultJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await fs.writeFile(resultMd, toMarkdown(result), "utf8");

  console.log(`[observe-real-round] result_json=${resultJson}`);
  console.log(`[observe-real-round] result_md=${resultMd}`);
  console.log(
    `[observe-real-round] status=${result.status} converged=${result.convergence.converged} blockers=${result.convergence.blocker_count}`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[observe-real-round] error: ${message}`);
  process.exitCode = 1;
});
