import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const baseServer = "http://127.0.0.1:3000";

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  process.kill(pid, "SIGTERM");
}

async function waitForUrl(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {}
    await delay(500);
  }
  return false;
}

function parseNdjson(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function createProject(projectId) {
  const response = await fetch(`${baseServer}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      name: "Verify Step1",
      workspace_path: "D:/AiAgent/AutoDevelopFramework"
    })
  });
  if (![201, 409].includes(response.status)) {
    throw new Error(`create project failed: HTTP ${response.status}`);
  }
}

async function postReport(projectId) {
  const response = await fetch(`${baseServer}/api/projects/${projectId}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "1.0",
      report_id: `verify-${Date.now()}`,
      project_id: projectId,
      session_id: "verify-session-a",
      agent_id: "verify-agent-a",
      task_id: "verify-task-1",
      status: "HANDOFF",
      summary: "step1 verification report",
      next_actions: [
        {
          target_session_id: "verify-session-b",
          to_agent_id: "verify-agent-b",
          type: "ASSIGN_TASK",
          payload: { note: "continue work" }
        }
      ],
      manager_requests: [{ type: "RELEASE_LOCKS" }]
    })
  });
  if (response.status !== 201) {
    const text = await response.text();
    throw new Error(`post report failed: HTTP ${response.status} ${text}`);
  }
}

async function runCodex(projectId) {
  const response = await fetch(`${baseServer}/api/projects/${projectId}/codex/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "verify-session-a",
      task_id: "verify-task-1",
      prompt: "print verification message and exit",
      timeout_ms: 20000
    })
  });

  if (response.status !== 201) {
    const text = await response.text();
    throw new Error(`codex run failed: HTTP ${response.status} ${text}`);
  }
}

async function verifyEvents(projectId) {
  const response = await fetch(`${baseServer}/api/projects/${projectId}/events`);
  if (!response.ok) {
    throw new Error(`read events failed: HTTP ${response.status}`);
  }
  const events = parseNdjson(await response.text());
  const types = new Set(events.map((event) => event.eventType));

  if (!types.has("AGENT_FINAL_REPORT")) {
    throw new Error("AGENT_FINAL_REPORT not found");
  }
  if (!types.has("TASK_STATE_CHANGED")) {
    throw new Error("TASK_STATE_CHANGED not found");
  }
  if (!types.has("MANAGER_MESSAGE_ROUTED")) {
    throw new Error("MANAGER_MESSAGE_ROUTED not found");
  }
  if (!types.has("CODEX_RUN_STARTED") || !types.has("CODEX_RUN_FINISHED")) {
    throw new Error("CODEX_RUN events not found");
  }

  return events.length;
}

async function verifyInbox(projectId) {
  const response = await fetch(`${baseServer}/api/projects/${projectId}`);
  if (!response.ok) {
    throw new Error(`read project detail failed: HTTP ${response.status}`);
  }
  const detail = await response.json();
  if (!Array.isArray(detail.inboxSessions) || !detail.inboxSessions.includes("verify-session-b")) {
    throw new Error("target inbox session not found");
  }
  return detail.inboxSessions;
}

async function main() {
  let projectId;
  const proc =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", "corepack pnpm dev"], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"]
        })
      : spawn("corepack", ["pnpm", "dev"], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"]
        });

  let logs = "";
  proc.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });

  try {
    const serverReady = await waitForUrl(`${baseServer}/healthz`, 60000);
    if (!serverReady) {
      throw new Error("server not ready");
    }

    projectId = `verify_step1_${Date.now()}`;
    await createProject(projectId);
    await postReport(projectId);
    await runCodex(projectId);
    const eventCount = await verifyEvents(projectId);
    const inboxSessions = await verifyInbox(projectId);

    console.log("[verify_step1] events:", eventCount);
    console.log("[verify_step1] inbox sessions:", inboxSessions);
  } finally {
    killTree(proc.pid);
    await delay(400);
    if (projectId) {
      const projectDir = path.join(process.cwd(), "data", "projects", projectId);
      await fs.rm(projectDir, { recursive: true, force: true });
    }
    if (logs.trim()) {
      console.log("[verify_step1] captured logs:");
      console.log(logs.split("\n").slice(-30).join("\n"));
    }
  }
}

main().catch((error) => {
  console.error("[verify_step1] failed:", error.message);
  process.exitCode = 1;
});
