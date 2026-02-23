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
  const projectId = `verify_step5_${Date.now()}`;
  const port = Number(process.env.VERIFY_PORT ?? 3315);
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

    const project = await postJson(`${baseUrl}/api/projects`, {
      project_id: projectId,
      name: "Verify Step5",
      workspace_path: "D:/AiAgent/AutoDevelopFramework"
    });
    if (![201, 409].includes(project.status)) {
      throw new Error(`create project failed: ${project.status}`);
    }

    const sessionA = await postJson(`${baseUrl}/api/projects/${projectId}/sessions`, {
      session_id: "sess-dev-a",
      role: "dev_backend"
    });
    if (![200, 201].includes(sessionA.status)) {
      throw new Error("add session A failed");
    }
    await delay(30);
    const sessionB = await postJson(`${baseUrl}/api/projects/${projectId}/sessions`, {
      session_id: "sess-dev-b",
      role: "dev_backend"
    });
    if (![200, 201].includes(sessionB.status)) {
      throw new Error("add session B failed");
    }

    const routed = await postJson(`${baseUrl}/api/projects/${projectId}/messages/send`, {
      to: { agent: "dev_backend", session_id: null },
      content: "verify step5 route latest session",
      mode: "TASK_ASSIGN"
    });
    if (routed.status !== 201) {
      throw new Error(`message send failed: ${routed.status} ${JSON.stringify(routed.body)}`);
    }
    if (routed.body.resolvedSessionId !== "sess-dev-b") {
      throw new Error(`expected resolvedSessionId=sess-dev-b, got ${routed.body.resolvedSessionId}`);
    }

    const inboxResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/inbox/sess-dev-b?limit=1`
    );
    const inboxPayload = await inboxResponse.json();
    if (!inboxResponse.ok || !Array.isArray(inboxPayload.items) || inboxPayload.items.length !== 1) {
      throw new Error("inbox tail verification failed");
    }

    const eventsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/events`);
    if (!eventsResponse.ok) {
      throw new Error("events query failed");
    }
    const events = parseNdjson(await eventsResponse.text());
    const eventTypes = new Set(events.map((event) => event.eventType));
    if (!eventTypes.has("USER_MESSAGE_RECEIVED") || !eventTypes.has("MESSAGE_ROUTED")) {
      throw new Error("step5 event chain not found");
    }

    console.log("[verify_step5] route + event chain validated");
  } finally {
    killTree(proc.pid);
    await delay(400);
    await fs.rm(path.join(process.cwd(), "data", "projects", projectId), { recursive: true, force: true });
    if (logs.trim()) {
      console.log("[verify_step5] captured logs:");
      console.log(logs.split("\n").slice(-25).join("\n"));
    }
  }
}

main().catch((error) => {
  console.error("[verify_step5] failed:", error.message);
  process.exitCode = 1;
});
