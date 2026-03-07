import { spawnSync } from "node:child_process";
import process from "node:process";

const jsonOutput = process.argv.includes("--json");
const minNodeMajor = 20;
const minPnpmMajor = 9;
const serverUrl = process.env.HEALTHCHECK_SERVER_URL ?? "http://127.0.0.1:43123/healthz";
const dashboardUrl = process.env.HEALTHCHECK_DASHBOARD_URL ?? "http://127.0.0.1:54174/";
const perCheckTimeoutMs = 4000;
const totalTimeoutMs = 10000;

function withTimeout(promise, timeoutMs, timeoutError) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(timeoutError), timeoutMs);
    })
  ]);
}

function compareMajor(version, minimum) {
  const major = Number(String(version).split(".")[0] ?? "0");
  return Number.isFinite(major) && major >= minimum;
}

function readPnpmVersion() {
  const result = spawnSync("pnpm", ["-v"], { encoding: "utf8" });
  if (result.status === 0) {
    return { ok: true, value: String(result.stdout).trim(), reason: "" };
  }

  const ua = String(process.env.npm_config_user_agent || "");
  const match = ua.match(/pnpm\/([0-9]+(?:\.[0-9]+){0,2})/i);
  if (match && match[1]) {
    return { ok: true, value: match[1], reason: "resolved from npm_config_user_agent" };
  }

  return {
    ok: false,
    value: "",
    reason: (result.stderr || result.stdout || "pnpm version check failed").trim()
  };
}

async function probeJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }
  const text = await response.text();
  return text;
}

async function probeText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }
  return response.text();
}

function print(result) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`status=${result.status}`);
  console.log(`reason=${result.reason}`);
  console.log(`duration_ms=${result.duration_ms}`);
  for (const check of result.checks) {
    console.log(
      `[${check.status}] ${check.id} reason=${check.reason} actual=${check.actual ?? "-"} expected=${check.expected ?? "-"}`
    );
  }
}

async function main() {
  const startedAt = Date.now();
  const checks = [];

  const nodeVersion = process.versions.node;
  checks.push({
    id: "node_version",
    status: compareMajor(nodeVersion, minNodeMajor) ? "PASS" : "FAIL",
    reason: compareMajor(nodeVersion, minNodeMajor) ? "node version ok" : "node version below minimum",
    actual: nodeVersion,
    expected: `>=${minNodeMajor}`,
    elapsed_ms: 0
  });

  const pnpmVersion = readPnpmVersion();
  checks.push({
    id: "pnpm_version",
    status: pnpmVersion.ok && compareMajor(pnpmVersion.value, minPnpmMajor) ? "PASS" : "FAIL",
    reason: pnpmVersion.ok
      ? compareMajor(pnpmVersion.value, minPnpmMajor)
        ? "pnpm version ok"
        : "pnpm version below minimum"
      : pnpmVersion.reason,
    actual: pnpmVersion.value || "unknown",
    expected: `>=${minPnpmMajor}`,
    elapsed_ms: 0
  });

  const serverStarted = Date.now();
  try {
    await withTimeout(probeJson(serverUrl), perCheckTimeoutMs, new Error("healthz_timeout"));
    checks.push({
      id: "server_healthz",
      status: "PASS",
      reason: "reachable",
      actual: serverUrl,
      expected: "reachable",
      elapsed_ms: Date.now() - serverStarted
    });
  } catch (error) {
    checks.push({
      id: "server_healthz",
      status: "FAIL",
      reason: "healthz_unreachable",
      actual: error instanceof Error ? error.message : String(error),
      expected: serverUrl,
      elapsed_ms: Date.now() - serverStarted
    });
  }

  const dashboardStarted = Date.now();
  try {
    await withTimeout(probeText(dashboardUrl), perCheckTimeoutMs, new Error("dashboard_timeout"));
    checks.push({
      id: "dashboard_http",
      status: "PASS",
      reason: "reachable",
      actual: dashboardUrl,
      expected: "reachable",
      elapsed_ms: Date.now() - dashboardStarted
    });
  } catch (error) {
    checks.push({
      id: "dashboard_http",
      status: "FAIL",
      reason: "dashboard_unreachable",
      actual: error instanceof Error ? error.message : String(error),
      expected: dashboardUrl,
      elapsed_ms: Date.now() - dashboardStarted
    });
  }

  const status = checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
  const firstFailure = checks.find((item) => item.status === "FAIL");
  const duration = Date.now() - startedAt;
  const result = {
    status,
    reason: firstFailure ? firstFailure.reason : "all_checks_passed",
    duration_ms: duration,
    timeout_budget_ms: totalTimeoutMs,
    timestamp: new Date().toISOString(),
    checks
  };
  print(result);
  if (duration > totalTimeoutMs || status !== "PASS") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const result = {
    status: "FAIL",
    reason: "healthcheck_runtime_error",
    duration_ms: 0,
    timeout_budget_ms: totalTimeoutMs,
    timestamp: new Date().toISOString(),
    checks: [
      {
        id: "healthcheck_runtime",
        status: "FAIL",
        reason: error instanceof Error ? error.message : String(error),
        actual: "exception",
        expected: "successful execution",
        elapsed_ms: 0
      }
    ]
  };
  print(result);
  process.exitCode = 1;
});
