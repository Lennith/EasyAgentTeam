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
  const projectId = `verify_step2_${Date.now()}`;
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
    const ready = await waitForUrl("http://127.0.0.1:3000/healthz", 60000);
    if (!ready) {
      throw new Error("server not ready");
    }

    const cmd =
      process.platform === "win32"
        ? `set PROJECT_ID=${projectId}&&node --import tsx tools/mock_lock.ts`
        : `PROJECT_ID=${projectId} node --import tsx tools/mock_lock.ts`;
    const runner =
      process.platform === "win32"
        ? spawnSync("cmd.exe", ["/d", "/s", "/c", cmd], { cwd: process.cwd(), stdio: "inherit" })
        : spawnSync("sh", ["-c", cmd], { cwd: process.cwd(), stdio: "inherit" });

    if (runner.status !== 0) {
      throw new Error("mock_lock script failed");
    }

    const eventsResponse = await fetch(`http://127.0.0.1:3000/api/projects/${projectId}/events`);
    if (!eventsResponse.ok) {
      throw new Error("failed to fetch events");
    }
    const raw = await eventsResponse.text();
    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const types = new Set(events.map((event) => event.eventType));
    if (!types.has("LOCK_ACQUIRED") || !types.has("LOCK_ACQUIRE_FAILED") || !types.has("LOCK_STOLEN")) {
      throw new Error("expected lock events were not found");
    }
    console.log(
      "[verify_step2] lock events validated:",
      [...types].filter((t) => String(t).startsWith("LOCK_"))
    );
  } finally {
    killTree(proc.pid);
    await delay(400);
    await fs.rm(path.join(process.cwd(), "data", "projects", projectId), { recursive: true, force: true });
    if (logs.trim()) {
      console.log("[verify_step2] captured logs:");
      console.log(logs.split("\n").slice(-25).join("\n"));
    }
  }
}

main().catch((error) => {
  console.error("[verify_step2] failed:", error.message);
  process.exitCode = 1;
});
