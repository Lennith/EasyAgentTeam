import { AgentWorkspaceError } from "../src/errors.mjs";

function lowerText(value) {
  return String(value ?? "").toLowerCase();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function getTaskStateCounts(tasks) {
  const counts = new Map();
  for (const task of toArray(tasks)) {
    const state = String(task?.state ?? "").toUpperCase() || "UNKNOWN";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return counts;
}

function getDoneCount(tasks) {
  return toArray(tasks).filter((task) => String(task?.state ?? "").toUpperCase() === "DONE").length;
}

function getBlockingCount(tasks) {
  return toArray(tasks).filter((task) => {
    const state = String(task?.state ?? "").toUpperCase();
    return state === "FAILED" || state === "BLOCKED";
  }).length;
}

function topologicalTasks(tasks) {
  const items = toArray(tasks).map((task) => ({
    taskId: String(task?.taskId ?? task?.task_id ?? "").trim(),
    ownerRole: String(task?.ownerRole ?? task?.owner_role ?? "").trim(),
    dependencies: toArray(task?.dependencies).map((item) => String(item).trim()).filter(Boolean)
  }));
  const byId = new Map(items.map((item) => [item.taskId, item]));
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(taskId) {
    if (!taskId || visited.has(taskId)) {
      return;
    }
    if (visiting.has(taskId)) {
      throw new AgentWorkspaceError(`workflow task dependency cycle at '${taskId}'`, "CAMPAIGN_TASK_CYCLE");
    }
    visiting.add(taskId);
    const item = byId.get(taskId);
    if (item) {
      for (const depId of item.dependencies) {
        if (byId.has(depId)) {
          visit(depId);
        }
      }
      ordered.push(item);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const item of items) {
    visit(item.taskId);
  }
  return ordered.filter((item) => item.taskId);
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
    throw new AgentWorkspaceError(`runtime request failed: ${method} ${routePath} -> ${response.status}`, "RUNTIME_HTTP", {
      method,
      routePath,
      status: response.status,
      payload
    });
  }
  return payload;
}

export function categorizeFailure(input) {
  const stage = lowerText(input?.stage);
  const categoryHint = lowerText(input?.categoryHint);
  const errorCode = lowerText(input?.error?.code);
  const message = lowerText(input?.error?.message);
  const detailsJson = lowerText(JSON.stringify(input?.error?.details ?? {}));
  const full = `${stage} ${categoryHint} ${errorCode} ${message} ${detailsJson}`;

  const httpStatus = Number(input?.error?.details?.status);
  if (Number.isFinite(httpStatus) && httpStatus >= 500) {
    return "backend_suspect";
  }
  if (full.includes("route_table") || full.includes("owner_role") || full.includes("dependency") || full.includes("qa_guard")) {
    return "template_design";
  }
  if (stage.includes("runtime") && (full.includes("timeout") || full.includes("blocked") || full.includes("failed"))) {
    return "runtime_nonconverge";
  }
  if (full.includes("skill") || full.includes("prompt") || full.includes("constraint")) {
    return "constraint_gap";
  }
  if (stage.includes("runtime")) {
    return "runtime_nonconverge";
  }
  return "constraint_gap";
}

export function deriveConstraintUpdates(input) {
  const category = String(input?.category ?? "");
  if (category === "template_design") {
    return [
      "Enforce route_table/task_assign_route_table closure check before bundle output.",
      "Require explicit QA guard ownership on final acceptance task."
    ];
  }
  if (category === "runtime_nonconverge") {
    return [
      "Require dependency-topological task report strategy and avoid early completion.",
      "Add runtime progress checkpoint before declaring scenario complete."
    ];
  }
  if (category === "backend_suspect") {
    return [
      "Capture raw HTTP request/response evidence and mark backend_suspect for end-of-campaign review."
    ];
  }
  return [
    "Strengthen prompt constraints on bundle field completeness and deterministic id naming."
  ];
}

export function judgeRuntimeConvergence(input) {
  const beforeRuntime = input?.beforeRuntime ?? {};
  const finalRuntime = input?.finalRuntime ?? {};
  const runStatus = String(input?.runStatus ?? "");
  const beforeDone = getDoneCount(beforeRuntime?.tasks);
  const afterDone = getDoneCount(finalRuntime?.tasks);
  const blockerCount = getBlockingCount(finalRuntime?.tasks);
  const progressed = afterDone > beforeDone;
  const converged = progressed && blockerCount === 0;
  return {
    status: converged ? "pass" : "fail",
    progressed,
    blocker_count: blockerCount,
    before_done_count: beforeDone,
    after_done_count: afterDone,
    run_status: runStatus
  };
}

export async function observeWorkflowRun(input) {
  const baseUrl = String(input.baseUrl || "").trim();
  const runId = String(input.runId || "").trim();
  const orderedTasks = topologicalTasks(input.tasks);
  const maxPollSeconds = Number.isFinite(Number(input.maxPollSeconds)) ? Number(input.maxPollSeconds) : 10;
  const roleSessionPrefix = String(input.roleSessionPrefix || "campaign").trim();

  if (!baseUrl || !runId) {
    throw new AgentWorkspaceError("observeWorkflowRun requires baseUrl and runId", "CAMPAIGN_RUNTIME_INPUT_INVALID");
  }
  if (orderedTasks.length === 0) {
    throw new AgentWorkspaceError("observeWorkflowRun requires at least one workflow task", "CAMPAIGN_RUNTIME_INPUT_INVALID");
  }

  const beforeRuntime = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`, undefined, [
    200
  ]);
  await requestJson(baseUrl, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/start`, {}, [200]);

  const roles = Array.from(new Set(orderedTasks.map((item) => item.ownerRole).filter(Boolean)));
  for (const role of roles) {
    await requestJson(
      baseUrl,
      "POST",
      `/api/workflow-runs/${encodeURIComponent(runId)}/sessions`,
      {
        role,
        session_id: `${roleSessionPrefix}-${runId}-${role}`
      },
      [200, 201]
    );
  }

  const dispatchLog = [];
  for (const item of orderedTasks) {
    const payload = await requestJson(
      baseUrl,
      "POST",
      `/api/workflow-runs/${encodeURIComponent(runId)}/task-actions`,
      {
        action_type: "TASK_REPORT",
        from_agent: item.ownerRole,
        from_session_id: `${roleSessionPrefix}-${runId}-${item.ownerRole}`,
        results: [{ task_id: item.taskId, outcome: "DONE", summary: `${item.taskId} done by campaign runner` }]
      },
      [200]
    );
    dispatchLog.push({ task_id: item.taskId, role: item.ownerRole, success: Boolean(payload?.success ?? true) });
  }

  let finalStatus = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/status`, undefined, [200]);
  let finalRuntime = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`, undefined, [200]);
  const deadline = Date.now() + maxPollSeconds * 1000;
  while (Date.now() < deadline) {
    const stateCounts = getTaskStateCounts(finalRuntime?.tasks);
    const hasRunning = (stateCounts.get("RUNNING") ?? 0) > 0 || (stateCounts.get("READY") ?? 0) > 0;
    if (!hasRunning) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    finalStatus = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/status`, undefined, [200]);
    finalRuntime = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`, undefined, [200]);
  }

  const judged = judgeRuntimeConvergence({
    beforeRuntime,
    finalRuntime,
    runStatus: String(finalStatus?.status ?? "")
  });

  return {
    status: judged.status,
    run_id: runId,
    progressed: judged.progressed,
    blocker_count: judged.blocker_count,
    before_done_count: judged.before_done_count,
    after_done_count: judged.after_done_count,
    run_status: judged.run_status,
    dispatch_log: dispatchLog,
    before_runtime: beforeRuntime,
    final_runtime: finalRuntime
  };
}
