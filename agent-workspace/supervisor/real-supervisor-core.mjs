import fs from "node:fs/promises";
import path from "node:path";
import { AgentWorkspaceError } from "../src/errors.mjs";

function normalizeEventType(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : "UNKNOWN";
}

function toUpperState(value) {
  return String(value ?? "").trim().toUpperCase();
}

async function fileExists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadRunEventsFromDataRoot(dataRoot, runId) {
  const eventsPath = path.resolve(dataRoot, "workflows", "runs", runId, "events.jsonl");
  try {
    const raw = await fs.readFile(eventsPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const items = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item) => item && typeof item === "object");
    return {
      events_path: eventsPath,
      events: items
    };
  } catch (error) {
    throw new AgentWorkspaceError("failed to read workflow run events", "SUPERVISOR_EVENTS_READ_FAILED", {
      run_id: runId,
      events_path: eventsPath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function summarizeEventEvidence(events) {
  const counts = new Map();
  const timeline = [];
  for (const event of Array.isArray(events) ? events : []) {
    const eventType = normalizeEventType(event?.eventType);
    counts.set(eventType, (counts.get(eventType) ?? 0) + 1);
    timeline.push({
      created_at: String(event?.createdAt ?? ""),
      event_type: eventType,
      source: String(event?.source ?? ""),
      session_id: String(event?.sessionId ?? ""),
      task_id: String(event?.taskId ?? "")
    });
  }
  const event_counts = Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const dispatchStartedCount = counts.get("ORCHESTRATOR_DISPATCH_STARTED") ?? 0;
  const dispatchFinishedCount = counts.get("ORCHESTRATOR_DISPATCH_FINISHED") ?? 0;
  const taskReportAppliedCount = counts.get("TASK_REPORT_APPLIED") ?? 0;
  const fakeReportPath = dispatchStartedCount === 0 && dispatchFinishedCount === 0 && taskReportAppliedCount > 0;
  const dispatchStartedGap = dispatchStartedCount === 0 && dispatchFinishedCount > 0;
  return {
    events_total: timeline.length,
    event_counts,
    has_dispatch_started: dispatchStartedCount > 0,
    has_dispatch_finished: dispatchFinishedCount > 0,
    dispatch_started_count: dispatchStartedCount,
    dispatch_finished_count: dispatchFinishedCount,
    task_report_applied_count: taskReportAppliedCount,
    fake_report_path: fakeReportPath,
    dispatch_started_gap: dispatchStartedGap,
    timeline
  };
}

export function summarizeRuntimeStatus(statusPayload, runtimePayload) {
  const runStatus = String(statusPayload?.status ?? "");
  const tasks = Array.isArray(runtimePayload?.tasks) ? runtimePayload.tasks : [];
  const states = tasks.map((task) => toUpperState(task?.state));
  const stateCounts = new Map();
  for (const state of states) {
    stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
  }
  const blockerCount =
    (stateCounts.get("BLOCKED") ?? 0) +
    (stateCounts.get("BLOCKED_DEP") ?? 0) +
    (stateCounts.get("FAILED") ?? 0);
  const doneCount = stateCounts.get("DONE") ?? 0;
  const totalCount = tasks.length;
  const allDone = totalCount > 0 && doneCount === totalCount;
  return {
    run_status: runStatus,
    total_tasks: totalCount,
    done_tasks: doneCount,
    blocker_count: blockerCount,
    all_done: allDone,
    task_states: Object.fromEntries([...stateCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])))
  };
}

function resolveArtifactCandidates(workspacePath, artifactPath) {
  const workspace = path.resolve(workspacePath);
  const normalizedArtifact = String(artifactPath ?? "").trim().replace(/\\/g, "/");
  if (!normalizedArtifact) {
    return [];
  }
  const candidates = new Set();
  if (path.isAbsolute(normalizedArtifact)) {
    candidates.add(path.resolve(normalizedArtifact));
  } else {
    candidates.add(path.resolve(workspace, normalizedArtifact));
    if (normalizedArtifact.startsWith("./")) {
      candidates.add(path.resolve(workspace, normalizedArtifact.slice(2)));
    }
    if (normalizedArtifact.startsWith("workspace/")) {
      candidates.add(path.resolve(workspace, normalizedArtifact.slice("workspace/".length)));
      candidates.add(path.resolve(path.dirname(workspace), normalizedArtifact));
    }
  }
  return [...candidates.values()];
}

export async function checkArtifactsExistence(tasks, workspacePath) {
  const checks = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const taskId = String(task?.taskId ?? task?.task_id ?? "").trim();
    const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
    for (const artifact of artifacts) {
      const artifactText = String(artifact ?? "").trim();
      if (!artifactText) {
        continue;
      }
      const candidates = resolveArtifactCandidates(workspacePath, artifactText);
      let exists = false;
      for (const candidate of candidates) {
        if (await fileExists(candidate)) {
          exists = true;
          break;
        }
      }
      checks.push({
        task_id: taskId,
        artifact: artifactText,
        checked_paths: candidates,
        exists
      });
    }
  }
  const missing = checks.filter((item) => !item.exists);
  return {
    workspace_path: workspacePath,
    total_artifacts: checks.length,
    existing_artifacts: checks.length - missing.length,
    missing_artifacts: missing.length,
    items: checks
  };
}

export function classifyRoundOutcome(input) {
  const runtime = input.runtimeSummary;
  const events = input.eventEvidence;
  const artifacts = input.artifactCheck;
  if (events.fake_report_path) {
    return {
      status: "fail",
      category: "fake_report_path",
      reason: "TASK_REPORT was applied without any orchestrator dispatch start event."
    };
  }
  if (!events.has_dispatch_finished) {
    return {
      status: "fail",
      category: "no_dispatch",
      reason: "Missing orchestrator dispatch lifecycle evidence."
    };
  }
  if (artifacts.missing_artifacts > 0) {
    return {
      status: "fail",
      category: "missing_artifacts",
      reason: "Required task artifacts were not found in workspace."
    };
  }
  if (runtime.blocker_count > 0 || !runtime.all_done) {
    return {
      status: "fail",
      category: "runtime_nonconverge",
      reason: "Workflow runtime did not converge to all DONE with zero blockers."
    };
  }
  if (events.dispatch_started_gap) {
    return {
      status: "pass",
      category: "pass_with_event_gap",
      reason: "Run converged, but ORCHESTRATOR_DISPATCH_STARTED events were missing while DISPATCH_FINISHED existed."
    };
  }
  return {
    status: "pass",
    category: "pass",
    reason: "Dispatch lifecycle, runtime, and artifact evidence all satisfied."
  };
}

export function deriveConstraintUpdateFromFailure(category) {
  if (category === "fake_report_path") {
    return "Do not include TASK_REPORT/task-actions/run-start instructions in prompts or task text.";
  }
  if (category === "no_dispatch") {
    return "Ensure task design requires executable outputs that trigger real dispatch rather than summary-only completion.";
  }
  if (category === "missing_artifacts") {
    return "Every task must define deterministic artifacts and execution must materialize them before QA acceptance.";
  }
  if (category === "runtime_nonconverge") {
    return "Tighten dependencies, ownership, and exception handling to avoid non-convergent execution paths.";
  }
  return "Preserve current constraints and keep role/task contracts explicit and reusable.";
}

export function renderRoundResultMarkdown(result) {
  const lines = [];
  lines.push(`# Round ${result.round} - ${result.scenario_id}`);
  lines.push("");
  lines.push(`- status: ${result.status}`);
  lines.push(`- category: ${result.category}`);
  lines.push(`- reason: ${result.reason}`);
  lines.push(`- run_id: ${result.run_id || "n/a"}`);
  lines.push(`- run_status: ${result.runtime.run_status}`);
  lines.push(`- dispatch_started: ${result.events.dispatch_started_count}`);
  lines.push(`- dispatch_finished: ${result.events.dispatch_finished_count}`);
  lines.push(`- fake_report_path: ${result.events.fake_report_path}`);
  lines.push(`- blocker_count: ${result.runtime.blocker_count}`);
  lines.push(`- done_tasks: ${result.runtime.done_tasks}/${result.runtime.total_tasks}`);
  lines.push(`- missing_artifacts: ${result.artifacts.missing_artifacts}/${result.artifacts.total_artifacts}`);
  lines.push("");
  lines.push("## Event Counts");
  for (const [eventType, count] of Object.entries(result.events.event_counts)) {
    lines.push(`- ${eventType}: ${count}`);
  }
  if (Object.keys(result.events.event_counts).length === 0) {
    lines.push("- (none)");
  }
  lines.push("");
  return `${lines.join("\n").trim()}\n`;
}

export function renderRootCauseMarkdown(result) {
  const lines = [];
  lines.push(`# Root Cause - Round ${result.round}`);
  lines.push("");
  lines.push(`- scenario: ${result.scenario_id}`);
  lines.push(`- category: ${result.category}`);
  lines.push(`- status: ${result.status}`);
  lines.push(`- reason: ${result.reason}`);
  lines.push("");
  lines.push("## Evidence Summary");
  lines.push(`- dispatch_started_count: ${result.events.dispatch_started_count}`);
  lines.push(`- dispatch_finished_count: ${result.events.dispatch_finished_count}`);
  lines.push(`- task_report_applied_count: ${result.events.task_report_applied_count}`);
  lines.push(`- fake_report_path: ${result.events.fake_report_path}`);
  lines.push(`- run_status: ${result.runtime.run_status}`);
  lines.push(`- blocker_count: ${result.runtime.blocker_count}`);
  lines.push(`- missing_artifacts: ${result.artifacts.missing_artifacts}`);
  lines.push("");
  return `${lines.join("\n").trim()}\n`;
}
