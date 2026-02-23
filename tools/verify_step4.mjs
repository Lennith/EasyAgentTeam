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

async function main() {
  const projectId = `verify_step4_${Date.now()}`;
  const session = "sess-dev-1";
  const port = Number(process.env.VERIFY_PORT ?? 3314);
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

    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        name: "Verify Step4",
        workspace_path: "D:/AiAgent/AutoDevelopFramework"
      })
    });
    if (![201, 409].includes(projectRes.status)) {
      throw new Error(`create project failed: HTTP ${projectRes.status}`);
    }

    const sessionRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: session,
        role: "dev_backend",
        status: "idle"
      })
    });
    if (![200, 201].includes(sessionRes.status)) {
      throw new Error(`session add failed: HTTP ${sessionRes.status}`);
    }

    const sendRes = await fetch(`${baseUrl}/api/projects/${projectId}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: { agent: "dev_backend", session_id: null },
        content: "verify step4 inbox tail",
        mode: "CHAT"
      })
    });
    if (sendRes.status !== 201) {
      throw new Error(`send message failed: HTTP ${sendRes.status}`);
    }

    const inboxRes = await fetch(`${baseUrl}/api/projects/${projectId}/inbox/${session}?limit=5`);
    if (inboxRes.status !== 200) {
      throw new Error(`inbox tail failed: HTTP ${inboxRes.status}`);
    }
    const inboxPayload = await inboxRes.json();
    const items = Array.isArray(inboxPayload.items) ? inboxPayload.items : [];
    if (items.length === 0) {
      throw new Error("inbox has no routed messages");
    }

    console.log("[verify_step4] session/inbox API flow validated");
  } finally {
    killTree(proc.pid);
    await delay(400);
    await fs.rm(path.join(process.cwd(), "data", "projects", projectId), { recursive: true, force: true });
    if (logs.trim()) {
      console.log("[verify_step4] captured logs:");
      console.log(logs.split("\n").slice(-25).join("\n"));
    }
  }
}

main().catch((error) => {
  console.error("[verify_step4] failed:", error.message);
  process.exitCode = 1;
});
