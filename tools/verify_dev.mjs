import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const serverHost = process.env.HOST ?? "127.0.0.1";
const serverPort = Number(process.env.PORT ?? 43123);
const uiHost = process.env.VITE_DEV_HOST ?? "localhost";
const uiPort = Number(process.env.VITE_DEV_PORT ?? 54174);
const baseServer = `http://${serverHost}:${serverPort}`;
const baseUi = `http://${uiHost}:${uiPort}`;
const startTimeoutMs = 60000;
const requestTimeoutMs = Number(process.env.VERIFY_DEV_REQUEST_TIMEOUT_MS ?? 5000);
const hardTimeoutMs = Number(process.env.VERIFY_DEV_HARD_TIMEOUT_MS ?? 180000);

function assertPortAvailable(host, port, label) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (error) => {
      const known = error;
      if (known && typeof known === "object" && known.code === "EADDRINUSE") {
        reject(new Error(`${label} port already in use: ${host}:${port}`));
        return;
      }
      reject(error);
    });
    server.listen({ host, port }, () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve();
      });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  process.kill(pid, "SIGTERM");
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForUrl(url, timeoutMs, shouldStop = () => false) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (shouldStop()) {
      return false;
    }
    try {
      const response = await fetchWithTimeout(url, requestTimeoutMs);
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {}
    await delay(500);
  }
  return false;
}

async function checkJson(url) {
  const response = await fetchWithTimeout(url, requestTimeoutMs);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
  await assertPortAvailable(serverHost, serverPort, "server");
  await assertPortAvailable(uiHost, uiPort, "dashboard-v2");

  const hasCorepack =
    spawnSync("corepack", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
  const devCommand = hasCorepack ? "corepack pnpm dev" : "pnpm dev";
  const proc =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", devCommand], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"]
        })
      : hasCorepack
        ? spawn("corepack", ["pnpm", "dev"], {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"]
          })
        : spawn("pnpm", ["dev"], {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"]
          });

  let logs = "";
  let childExited = false;
  let childExitCode = null;
  let hardTimeoutReached = false;
  proc.on("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });
  proc.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });

  const hardStop = setTimeout(() => {
    hardTimeoutReached = true;
    killTree(proc.pid);
  }, hardTimeoutMs);

  let failure = null;
  try {
    const serverReady = await waitForUrl(
      `${baseServer}/healthz`,
      startTimeoutMs,
      () => childExited || hardTimeoutReached
    );
    const uiReady = await waitForUrl(`${baseUi}/`, startTimeoutMs, () => childExited || hardTimeoutReached);

    if (!serverReady) {
      if (hardTimeoutReached) {
        throw new Error(`verify_dev hard timeout reached (${hardTimeoutMs}ms)`);
      }
      if (childExited) {
        throw new Error(`dev process exited before server became ready (code=${String(childExitCode)})`);
      }
      throw new Error("server did not become ready on /healthz");
    }
    if (!uiReady) {
      if (hardTimeoutReached) {
        throw new Error(`verify_dev hard timeout reached (${hardTimeoutMs}ms)`);
      }
      if (childExited) {
        throw new Error(`dev process exited before dashboard became ready (code=${String(childExitCode)})`);
      }
      throw new Error("dashboard-v2 did not become ready on /");
    }

    const healthz = await checkJson(`${baseServer}/healthz`);
    const projectsDirect = await checkJson(`${baseServer}/api/projects`);
    const projectsViaUi = await checkJson(`${baseUi}/api/projects`);

    console.log("[verify_dev] /healthz:", healthz);
    console.log("[verify_dev] /api/projects (server):", projectsDirect);
    console.log("[verify_dev] /api/projects (dashboard-v2 proxy):", projectsViaUi);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(hardStop);
    killTree(proc.pid);
    await delay(500);
    if (logs.trim()) {
      console.log("[verify_dev] captured logs:\n" + logs.split("\n").slice(-40).join("\n"));
    }
  }

  if (hardTimeoutReached && !failure) {
    throw new Error(`verify_dev hard timeout reached (${hardTimeoutMs}ms)`);
  }
  if (failure) {
    throw failure;
  }
}

main().catch((error) => {
  console.error("[verify_dev] failed:", error.message);
  process.exitCode = 1;
});
