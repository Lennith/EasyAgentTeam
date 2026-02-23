import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const baseServer = "http://127.0.0.1:3000";
const baseUi = "http://127.0.0.1:5174";
const startTimeoutMs = 60000;

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

async function checkJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
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
    const serverReady = await waitForUrl(`${baseServer}/healthz`, startTimeoutMs);
    const uiReady = await waitForUrl(`${baseUi}/`, startTimeoutMs);

    if (!serverReady) {
      throw new Error("server did not become ready on /healthz");
    }
    if (!uiReady) {
      throw new Error("dashboard-v2 did not become ready on /");
    }

    const healthz = await checkJson(`${baseServer}/healthz`);
    const projectsDirect = await checkJson(`${baseServer}/api/projects`);
    const projectsViaUi = await checkJson(`${baseUi}/api/projects`);

    console.log("[verify_dev] /healthz:", healthz);
    console.log("[verify_dev] /api/projects (server):", projectsDirect);
    console.log("[verify_dev] /api/projects (dashboard-v2 proxy):", projectsViaUi);
  } finally {
    killTree(proc.pid);
    await delay(500);
    if (logs.trim()) {
      console.log("[verify_dev] captured logs:\n" + logs.split("\n").slice(-40).join("\n"));
    }
  }
}

main().catch((error) => {
  console.error("[verify_dev] failed:", error.message);
  process.exitCode = 1;
});
