import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

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

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

async function main() {
  const projectId = `verify_step6_${Date.now()}`;
  const port = Number(process.env.VERIFY_PORT ?? 3316);
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", "corepack pnpm --filter @autodev/server dev"], {
          cwd: process.cwd(),
          env: { ...process.env, PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe"]
        })
      : spawn("corepack", ["pnpm", "--filter", "@autodev/server", "dev"], {
          cwd: process.cwd(),
          env: { ...process.env, PORT: String(port) },
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
    const ready = await waitForUrl(`${baseUrl}/healthz`, 60000);
    if (!ready) {
      throw new Error("server not ready");
    }

    const templatesRes = await fetch(`${baseUrl}/api/agent-templates`);
    if (!templatesRes.ok) {
      throw new Error(`failed to read agent templates: HTTP ${templatesRes.status}`);
    }
    const templatesPayload = await templatesRes.json();
    const templates = new Map((templatesPayload.items ?? []).map((item) => [item.agentId, item]));
    for (const requiredId of ["PM", "planer"]) {
      if (!templates.has(requiredId)) {
        throw new Error(`missing required template ${requiredId}`);
      }
    }

    const agentsRes = await fetch(`${baseUrl}/api/agents`);
    if (!agentsRes.ok) {
      throw new Error(`failed to read agents: HTTP ${agentsRes.status}`);
    }
    const agentsPayload = await agentsRes.json();
    const existing = new Set((agentsPayload.items ?? []).map((item) => item.agentId));
    for (const requiredId of ["PM", "planer"]) {
      if (!existing.has(requiredId)) {
        const seed = templates.get(requiredId);
        const created = await postJson(`${baseUrl}/api/agents`, {
          agent_id: requiredId,
          display_name: seed.displayName ?? requiredId,
          prompt: seed.prompt
        });
        if (![201, 409].includes(created.status)) {
          throw new Error(`failed to create ${requiredId}: ${created.status}`);
        }
      }
    }

    const project = await postJson(`${baseUrl}/api/projects`, {
      project_id: projectId,
      name: "Verify Step6",
      workspace_path: "D:/AiAgent/AutoDevelopFramework",
      template_id: "none",
      agent_ids: ["PM", "planer"],
      route_table: {
        PM: ["planer"],
        planer: []
      }
    });
    if (![201, 409].includes(project.status)) {
      throw new Error(`create project failed: ${project.status}`);
    }

    await postJson(`${baseUrl}/api/projects/${projectId}/sessions`, {
      session_id: "sess-pm",
      role: "PM"
    });
    await postJson(`${baseUrl}/api/projects/${projectId}/sessions`, {
      session_id: "sess-planer",
      role: "planer"
    });

    const denied = await postJson(`${baseUrl}/api/projects/${projectId}/messages/send`, {
      from_agent: "planer",
      to: { agent: "PM", session_id: null },
      content: "illegal route",
      mode: "CHAT"
    });
    if (denied.status !== 403) {
      throw new Error(`expected 403 for illegal route, got ${denied.status}`);
    }

    const allowed = await postJson(`${baseUrl}/api/projects/${projectId}/messages/send`, {
      from_agent: "PM",
      to: { agent: "planer", session_id: null },
      content: "legal route",
      mode: "TASK_ASSIGN"
    });
    if (allowed.status !== 201) {
      throw new Error(`expected 201 for legal route, got ${allowed.status}`);
    }

    const eventsRes = await fetch(`${baseUrl}/api/projects/${projectId}/events`);
    if (!eventsRes.ok) {
      throw new Error("failed to read events");
    }
    const events = parseNdjson(await eventsRes.text());
    const types = new Set(events.map((item) => item.eventType));
    if (!types.has("MESSAGE_ROUTE_DENIED") || !types.has("MESSAGE_ROUTED")) {
      throw new Error("route policy events not found");
    }
    console.log("[verify_step6] agent registry + route policy validated");
  } finally {
    killTree(proc.pid);
    await delay(400);
    await fs.rm(path.join(process.cwd(), "data", "projects", projectId), { recursive: true, force: true });
    if (logs.trim()) {
      console.log("[verify_step6] captured logs:");
      console.log(logs.split("\n").slice(-20).join("\n"));
    }
  }
}

main().catch((error) => {
  console.error("[verify_step6] failed:", error.message);
  process.exitCode = 1;
});
