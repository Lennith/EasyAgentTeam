#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const staticTemplateRoot = path.resolve(repoRoot, "TemplateAgentWorkspace");
const fixtureRoot = path.resolve(repoRoot, "E2ETest", "fixtures", "template-agent");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = String(next);
    index += 1;
  }
  return args;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function nowStamp() {
  const now = new Date();
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function ensureDir(absolutePath) {
  await fs.mkdir(absolutePath, { recursive: true });
}

async function exists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(sourceDir, targetDir) {
  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await ensureDir(path.dirname(targetPath));
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function readJson(absolutePath) {
  const raw = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(absolutePath, payload) {
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeText(absolutePath, content) {
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, content, "utf8");
}

function replaceTokens(value, replacements) {
  if (typeof value === "string") {
    let next = value;
    for (const [token, replacement] of Object.entries(replacements)) {
      next = next.split(token).join(replacement);
    }
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceTokens(item, replacements));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, val] of Object.entries(value)) {
      const replacedKey = replaceTokens(key, replacements);
      next[replacedKey] = replaceTokens(val, replacements);
    }
    return next;
  }
  return value;
}

function resolveArtifactPath(workspacePath, artifactPath) {
  const normalized = String(artifactPath ?? "").trim().replace(/\\/g, "/");
  if (!normalized) {
    return "";
  }
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  if (normalized.startsWith("workspace/")) {
    return path.resolve(workspacePath, normalized.slice("workspace/".length));
  }
  if (normalized.startsWith("./")) {
    return path.resolve(workspacePath, normalized.slice(2));
  }
  return path.resolve(workspacePath, normalized);
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk.toString());
    });
    child.on("close", (code) => {
      resolve({ code: Number(code ?? 0), stdout, stderr });
    });
  });
}

async function requestJsonWithStatus(baseUrl, method, routePath, body, expectedStatus = [200]) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = {};
  const text = await response.text();
  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!expectedStatus.includes(response.status)) {
    throw new Error(`${method} ${routePath} expected ${expectedStatus.join("/")} got ${response.status}`);
  }
  return {
    status: response.status,
    payload
  };
}

async function requestJson(baseUrl, method, routePath, body, expectedStatus = [200]) {
  const response = await requestJsonWithStatus(baseUrl, method, routePath, body, expectedStatus);
  return response.payload;
}

async function submitTaskReportWithRetry({
  baseUrl,
  runId,
  ownerRole,
  sessionId,
  taskId,
  summary,
  maxAttempts = 10,
  waitMs = 1200
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await requestJsonWithStatus(
      baseUrl,
      "POST",
      `/api/workflow-runs/${encodeURIComponent(runId)}/task-actions`,
      {
        action_type: "TASK_REPORT",
        from_agent: ownerRole,
        from_session_id: sessionId,
        results: [
          {
            task_id: taskId,
            outcome: "DONE",
            summary
          }
        ]
      },
      [200, 201, 409]
    );
    if (response.status !== 409) {
      return {
        accepted: true,
        attempts: attempt,
        status: response.status
      };
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return {
    accepted: false,
    attempts: maxAttempts,
    status: 409
  };
}

async function loadEventsFromData(dataRoot, runId) {
  const eventsPath = path.resolve(dataRoot, "workflows", "runs", runId, "events.jsonl");
  if (!(await exists(eventsPath))) {
    return { eventsPath, items: [] };
  }
  const raw = await fs.readFile(eventsPath, "utf8");
  const items = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { eventsPath, items };
}

function summarizeEvents(events) {
  const counts = new Map();
  for (const item of events) {
    const type = String(item?.eventType ?? "UNKNOWN");
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const dispatchStarted = counts.get("ORCHESTRATOR_DISPATCH_STARTED") ?? 0;
  const dispatchFinished = counts.get("ORCHESTRATOR_DISPATCH_FINISHED") ?? 0;
  return {
    event_counts: Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    dispatch_started_count: dispatchStarted,
    dispatch_finished_count: dispatchFinished,
    task_report_applied_count: counts.get("TASK_REPORT_APPLIED") ?? 0,
    pass_with_event_gap: dispatchStarted === 0 && dispatchFinished > 0
  };
}

async function waitRunFinished(baseUrl, runId, timeoutSeconds) {
  const deadline = Date.now() + Math.max(10, Number(timeoutSeconds || 120)) * 1000;
  let latest = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/status`, undefined, [200]);
  while (Date.now() < deadline) {
    const status = String(latest?.status ?? "").toLowerCase();
    if (status === "finished" || status === "failed" || status === "stopped") {
      return { timedOut: false, statusPayload: latest };
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    latest = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/status`, undefined, [200]);
  }
  return { timedOut: true, statusPayload: latest };
}

async function createCaseSkill(workspaceRoot, folderName, skillId, description) {
  const skillDir = path.resolve(workspaceRoot, "skills", folderName);
  await ensureDir(path.join(skillDir, "assets"));
  const skillMd = `---\nname: ${skillId}\ndescription: ${description}\nlicense: MIT\ncompatibility: local\n---\n\n# ${skillId}\n\nTemplateAgent E2E fixture skill.\n`;
  await writeText(path.join(skillDir, "SKILL.md"), skillMd);
  await writeText(path.join(skillDir, "assets", "readme.txt"), "template-agent-e2e-skill\n");
}

async function prepareBundle(caseConfig) {
  await copyDirectory(staticTemplateRoot, caseConfig.workspaceRoot);

  const configPath = path.join(caseConfig.workspaceRoot, ".agent-tools", "config.json");
  const config = await readJson(configPath);
  config.base_url = caseConfig.baseUrl;
  await writeJson(configPath, config);

  await createCaseSkill(caseConfig.workspaceRoot, caseConfig.skillFolder, caseConfig.skillId, caseConfig.skillDescription);

  const fixtureJson = await readJson(caseConfig.fixturePath);
  const bundle = replaceTokens(fixtureJson, {
    "__PREFIX__": caseConfig.prefix,
    "__SKILL_ID__": caseConfig.skillId,
    "__WORKSPACE_PATH__": caseConfig.runWorkspacePath.replace(/\\/g, "/")
  });

  const bundlePath = path.join(caseConfig.workspaceRoot, "bundles", "submitted.bundle.json");
  await writeJson(bundlePath, bundle);
  return { bundlePath, bundle };
}

async function runTemplateGuard(caseWorkspace, repoRootPath) {
  const env = {
    ...process.env,
    EASYAGENTTEAM_ROOT: repoRootPath
  };
  const check = await runCommand(process.execPath, [".agent-tools/scripts/template_bundle_guard.mjs", "check"], {
    cwd: caseWorkspace,
    env
  });
  const publish = await runCommand(process.execPath, [".agent-tools/scripts/template_bundle_guard.mjs", "publish"], {
    cwd: caseWorkspace,
    env
  });
  const checkReportPath = path.join(caseWorkspace, "reports", "template-guard", "last_check.json");
  const publishReportPath = path.join(caseWorkspace, "reports", "template-guard", "last_publish.json");
  const checkReport = (await exists(checkReportPath)) ? await readJson(checkReportPath) : null;
  const publishReport = (await exists(publishReportPath)) ? await readJson(publishReportPath) : null;
  return {
    check,
    publish,
    checkReportPath,
    publishReportPath,
    checkReport,
    publishReport
  };
}

async function verifyRegistration(baseUrl, publishReport) {
  const projectId = String(publishReport?.project_id ?? "");
  const templateId = String(publishReport?.template_id ?? "");
  const runId = String(publishReport?.run_id ?? "");
  const projects = await requestJson(baseUrl, "GET", "/api/projects", undefined, [200]);
  const templates = await requestJson(baseUrl, "GET", "/api/workflow-templates", undefined, [200]);
  const runs = await requestJson(baseUrl, "GET", "/api/workflow-runs", undefined, [200]);

  const projectExists = Array.isArray(projects?.items) && projects.items.some((item) => String(item?.project_id ?? item?.projectId ?? "") === projectId);
  const templateExists = Array.isArray(templates?.items) && templates.items.some((item) => String(item?.templateId ?? item?.template_id ?? "") === templateId);
  const runExists = Array.isArray(runs?.items) && runs.items.some((item) => String(item?.runId ?? item?.run_id ?? "") === runId);

  return {
    project_id: projectId,
    template_id: templateId,
    run_id: runId,
    project_exists: projectExists,
    template_exists: templateExists,
    run_exists: runExists
  };
}

async function materializeArtifacts(workspacePath, task) {
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
  for (const artifact of artifacts) {
    const artifactPath = resolveArtifactPath(workspacePath, artifact);
    if (!artifactPath) {
      continue;
    }
    await ensureDir(path.dirname(artifactPath));
    const content = `# ${task.task_id || task.taskId}\n\nGenerated by template-agent e2e runner.\n`;
    await fs.writeFile(artifactPath, content, "utf8");
  }
}

async function runWorkflowExecution(baseUrl, bundle, publishReport, timeoutSeconds, dataRoot) {
  const runId = String(publishReport?.run_id ?? "");
  if (!runId) {
    throw new Error("publish report missing run_id");
  }
  await requestJson(baseUrl, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/start`, {}, [200]);

  const sessionMap = new Map();
  for (const agent of bundle.agents ?? []) {
    const role = String(agent?.agent_id ?? agent?.agentId ?? "").trim();
    if (!role) {
      continue;
    }
    const sessionId = `template-agent-${role}`;
    await requestJson(
      baseUrl,
      "POST",
      `/api/workflow-runs/${encodeURIComponent(runId)}/sessions`,
      { role, session_id: sessionId },
      [200, 201, 409]
    );
    sessionMap.set(role, sessionId);
  }

  const runWorkspacePath = String(bundle?.workflow_run?.workspace_path ?? bundle?.workflow_run?.workspacePath ?? "");
  for (const task of bundle.workflow_template?.tasks ?? []) {
    const ownerRole = String(task?.owner_role ?? task?.ownerRole ?? "").trim();
    const taskId = String(task?.task_id ?? task?.taskId ?? "").trim();
    if (!taskId || !ownerRole) {
      continue;
    }
    await materializeArtifacts(runWorkspacePath, task);
    const sessionId = sessionMap.get(ownerRole) || `template-agent-${ownerRole}`;
    const reportResult = await submitTaskReportWithRetry({
      baseUrl,
      runId,
      ownerRole,
      sessionId,
      taskId,
      summary: `${taskId} completed by template-agent e2e runner`
    });
    if (!reportResult.accepted) {
      throw new Error(
        `TASK_REPORT not accepted after ${reportResult.attempts} attempts for task ${taskId} (last_status=${reportResult.status})`
      );
    }
  }

  const statusObserved = await waitRunFinished(baseUrl, runId, timeoutSeconds);
  const runtime = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`, undefined, [200]);
  const runDetail = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`, undefined, [200]);

  const eventsLoaded = await loadEventsFromData(dataRoot, runId);
  const eventSummary = summarizeEvents(eventsLoaded.items);

  const artifactChecks = [];
  const runWorkspace = String(runDetail?.workspacePath ?? runWorkspacePath);
  for (const task of bundle.workflow_template?.tasks ?? []) {
    for (const artifact of task?.artifacts ?? []) {
      const artifactPath = resolveArtifactPath(runWorkspace, artifact);
      artifactChecks.push({
        task_id: String(task?.task_id ?? task?.taskId ?? ""),
        artifact: String(artifact),
        absolute_path: artifactPath,
        exists: artifactPath ? await exists(artifactPath) : false
      });
    }
  }

  const states = Array.isArray(runtime?.tasks) ? runtime.tasks.map((task) => String(task?.state ?? "")) : [];
  const blockerCount = states.filter((state) => ["BLOCKED", "BLOCKED_DEP", "FAILED"].includes(String(state).toUpperCase())).length;
  const doneCount = states.filter((state) => String(state).toUpperCase() === "DONE").length;

  return {
    run_id: runId,
    run_status: String(statusObserved?.statusPayload?.status ?? ""),
    timed_out: statusObserved.timedOut,
    blocker_count: blockerCount,
    done_count: doneCount,
    total_tasks: states.length,
    events_path: eventsLoaded.eventsPath,
    event_summary: eventSummary,
    artifact_checks: artifactChecks,
    missing_artifact_count: artifactChecks.filter((item) => !item.exists).length
  };
}

function renderCaseMarkdown(caseResult) {
  const lines = [];
  lines.push(`# ${caseResult.case_id}`);
  lines.push("");
  lines.push(`- status: ${caseResult.status}`);
  lines.push(`- reason: ${caseResult.reason}`);
  lines.push(`- bundle_path: ${caseResult.bundle_path}`);
  lines.push(`- publish_report: ${caseResult.publish_report_path}`);
  if (caseResult.registration) {
    lines.push(`- project_exists: ${caseResult.registration.project_exists}`);
    lines.push(`- template_exists: ${caseResult.registration.template_exists}`);
    lines.push(`- run_exists: ${caseResult.registration.run_exists}`);
  }
  if (caseResult.workflow_runtime) {
    lines.push(`- run_status: ${caseResult.workflow_runtime.run_status}`);
    lines.push(`- blocker_count: ${caseResult.workflow_runtime.blocker_count}`);
    lines.push(`- missing_artifact_count: ${caseResult.workflow_runtime.missing_artifact_count}`);
    lines.push(
      `- dispatch_started_count: ${caseResult.workflow_runtime.event_summary.dispatch_started_count}`
    );
    lines.push(
      `- dispatch_finished_count: ${caseResult.workflow_runtime.event_summary.dispatch_finished_count}`
    );
  }
  lines.push("");
  return `${lines.join("\n").trim()}\n`;
}

function renderSummaryMarkdown(summary) {
  const lines = [];
  lines.push("# Template Agent E2E Summary");
  lines.push("");
  lines.push(`- generated_at: ${summary.generated_at}`);
  lines.push(`- base_url: ${summary.base_url}`);
  lines.push(`- workspace_root: ${summary.workspace_root}`);
  lines.push(`- setup_only: ${summary.setup_only}`);
  lines.push(`- overall_status: ${summary.overall_status}`);
  lines.push(`- passed_cases: ${summary.passed_cases}/${summary.total_cases}`);
  lines.push("");
  lines.push("## Cases");
  for (const item of summary.cases) {
    lines.push(`- ${item.case_id}: ${item.status} (${item.reason})`);
  }
  lines.push("");
  return `${lines.join("\n").trim()}\n`;
}

async function runCase(caseConfig) {
  const result = {
    case_id: caseConfig.caseId,
    status: "fail",
    reason: "not_started",
    bundle_path: "",
    publish_report_path: "",
    check_report_path: "",
    workspace_root: caseConfig.workspaceRoot,
    registration: null,
    workflow_runtime: null
  };

  try {
    const prepared = await prepareBundle(caseConfig);
    result.bundle_path = prepared.bundlePath;

    const guard = await runTemplateGuard(caseConfig.workspaceRoot, repoRoot);
    result.check_report_path = guard.checkReportPath;
    result.publish_report_path = guard.publishReportPath;

    if (guard.check.code !== 0 || guard.publish.code !== 0 || !guard.publishReport || guard.publishReport.status !== "pass") {
      result.status = "fail";
      result.reason = "template_guard_failed";
      return result;
    }

    const registration = await verifyRegistration(caseConfig.baseUrl, guard.publishReport);
    result.registration = registration;

    if (!registration.project_exists || !registration.template_exists || !registration.run_exists) {
      result.status = "fail";
      result.reason = "registration_verification_failed";
      return result;
    }

    if (!caseConfig.runWorkflow || caseConfig.setupOnly) {
      result.status = "pass";
      result.reason = caseConfig.setupOnly ? "setup_only" : "publish_and_registration_ok";
      return result;
    }

    const runtime = await runWorkflowExecution(
      caseConfig.baseUrl,
      prepared.bundle,
      guard.publishReport,
      caseConfig.maxSeconds,
      caseConfig.dataRoot
    );
    result.workflow_runtime = runtime;

    if (runtime.timed_out) {
      result.status = "fail";
      result.reason = "workflow_timeout";
      return result;
    }
    if (String(runtime.run_status).toLowerCase() !== "finished") {
      result.status = "fail";
      result.reason = "workflow_not_finished";
      return result;
    }
    if (runtime.blocker_count > 0) {
      result.status = "fail";
      result.reason = "workflow_blocker_detected";
      return result;
    }
    if (runtime.missing_artifact_count > 0) {
      result.status = "fail";
      result.reason = "workflow_artifact_missing";
      return result;
    }

    if (runtime.event_summary.pass_with_event_gap) {
      result.status = "pass_with_event_gap";
      result.reason = "workflow_finished_with_dispatch_started_gap";
      return result;
    }

    result.status = "pass";
    result.reason = "workflow_finished_and_artifacts_present";
    return result;
  } catch (error) {
    result.status = "fail";
    result.reason = error instanceof Error ? error.message : String(error);
    return result;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = typeof args["base-url"] === "string" ? args["base-url"].trim() : "http://127.0.0.1:43123";
  const workspaceRoot =
    typeof args["workspace-root"] === "string"
      ? path.resolve(args["workspace-root"])
      : path.resolve(repoRoot, ".e2e-workspace", "TestTeam", "TemplateAgent");
  const dataRoot =
    typeof args["data-root"] === "string" ? path.resolve(args["data-root"]) : path.resolve(repoRoot, "data");
  const setupOnly = Boolean(args["setup-only"]);
  const maxSeconds = Number.isFinite(Number(args["max-seconds"])) ? Number(args["max-seconds"]) : 120;

  if (!(await exists(staticTemplateRoot))) {
    throw new Error(`TemplateAgentWorkspace not found: ${staticTemplateRoot}`);
  }

  const stamp = nowStamp();
  const outDir = path.resolve(workspaceRoot, "docs", "e2e", `${stamp}-template-agent`);
  await ensureDir(outDir);

  const cases = [
    {
      caseId: "workflow",
      fixturePath: path.resolve(fixtureRoot, "workflow.bundle.fixture.json"),
      workspaceRoot: path.resolve(workspaceRoot, `${stamp}-workflow-template-agent`),
      runWorkspacePath: path.resolve(workspaceRoot, `${stamp}-workflow-template-agent`, "workspace"),
      prefix: `e2e_ta_${Date.now()}_wf`,
      skillId: `e2e_ta_${Date.now()}_workflow_skill`,
      skillFolder: "workflow_toolkit",
      skillDescription: "TemplateAgent workflow fixture skill",
      runWorkflow: true,
      setupOnly,
      baseUrl,
      dataRoot,
      maxSeconds
    },
    {
      caseId: "project",
      fixturePath: path.resolve(fixtureRoot, "project.bundle.fixture.json"),
      workspaceRoot: path.resolve(workspaceRoot, `${stamp}-project-template-agent`),
      runWorkspacePath: path.resolve(workspaceRoot, `${stamp}-project-template-agent`, "workspace"),
      prefix: `e2e_ta_${Date.now()}_prj`,
      skillId: `e2e_ta_${Date.now()}_project_skill`,
      skillFolder: "project_toolkit",
      skillDescription: "TemplateAgent project fixture skill",
      runWorkflow: false,
      setupOnly,
      baseUrl,
      dataRoot,
      maxSeconds
    }
  ];

  const caseResults = [];
  for (const caseConfig of cases) {
    const caseResult = await runCase(caseConfig);
    caseResults.push(caseResult);
    await writeJson(path.join(outDir, `${caseConfig.caseId}.result.json`), caseResult);
    await writeText(path.join(outDir, `${caseConfig.caseId}.result.md`), renderCaseMarkdown(caseResult));
  }

  const passCount = caseResults.filter((item) => item.status === "pass" || item.status === "pass_with_event_gap").length;
  const overallPass = passCount === caseResults.length;
  const summary = {
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    workspace_root: workspaceRoot,
    setup_only: setupOnly,
    total_cases: caseResults.length,
    passed_cases: passCount,
    overall_status: overallPass ? "pass" : "fail",
    cases: caseResults
  };

  await writeJson(path.join(outDir, "template_agent_e2e_results.json"), summary);
  await writeText(path.join(outDir, "template_agent_e2e_results.md"), renderSummaryMarkdown(summary));

  const stabilityMetrics = {
    case_id: "template-agent",
    start_time: summary.generated_at,
    end_time: new Date().toISOString(),
    exit_code: overallPass ? 0 : 2,
    final_pass: overallPass,
    final_reason: overallPass ? "template_agent_e2e_ok" : "template_agent_e2e_failed",
    toolcall_failed_count: 0,
    toolcall_failed_timestamps: [],
    timeout_recovered_count: 0,
    timeout_recovered_timestamps: [],
    fallback_events: []
  };
  await writeJson(path.join(outDir, "stability_metrics.json"), stabilityMetrics);

  console.log("== Template Agent E2E Done ==");
  console.log(`artifacts=${outDir}`);
  console.log(`final_reason=${stabilityMetrics.final_reason}`);
  console.log(`runtime_pass=${overallPass}`);

  process.exitCode = overallPass ? 0 : 2;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[template-agent-e2e] error: ${message}`);
  process.exitCode = 2;
});
