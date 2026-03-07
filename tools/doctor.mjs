import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import process from "node:process";

const jsonOutput = process.argv.includes("--json");
const minNodeMajor = 20;
const minPnpmMajor = 9;
const repoRoot = process.cwd();

function compareMajor(version, minimum) {
  const major = Number(String(version).split(".")[0] ?? "0");
  return Number.isFinite(major) && major >= minimum;
}

function readPnpmVersion() {
  const result = spawnSync("pnpm", ["-v"], { cwd: repoRoot, encoding: "utf8" });
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

function findLockfiles() {
  const files = [];
  const queue = [repoRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "data" ||
        entry.name === "logs"
      ) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.name === "pnpm-lock.yaml" || entry.name === "package-lock.json" || entry.name === "yarn.lock") {
        files.push(path.relative(repoRoot, full).replaceAll("\\", "/"));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function checkPort(port) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      resolve({
        id: `port_${port}`,
        status: "PASS",
        reason: error && error.code === "EADDRINUSE" ? "occupied" : `unavailable: ${error?.code ?? "unknown"}`,
        actual: error?.code ?? "error",
        expected: "occupancy info",
        elapsed_ms: Date.now() - startedAt
      });
    });
    server.once("listening", () => {
      server.close(() => {
        resolve({
          id: `port_${port}`,
          status: "PASS",
          reason: "free",
          actual: "free",
          expected: "occupancy info",
          elapsed_ms: Date.now() - startedAt
        });
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

function print(result) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`status=${result.status}`);
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
    expected: `>=${minNodeMajor}`
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
    expected: `>=${minPnpmMajor}`
  });

  const lockfiles = findLockfiles();
  const extraLockfiles = lockfiles.filter((item) => item !== "pnpm-lock.yaml");
  checks.push({
    id: "lockfile_uniqueness",
    status: extraLockfiles.length === 0 ? "PASS" : "FAIL",
    reason: extraLockfiles.length === 0 ? "only pnpm lockfile found" : "unexpected lockfile(s) found",
    actual: lockfiles.join(", "),
    expected: "pnpm-lock.yaml only"
  });

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const requiredScripts = ["dev", "build", "lint", "test"];
  const missingScripts = requiredScripts.filter((item) => !packageJson.scripts || !packageJson.scripts[item]);
  checks.push({
    id: "required_scripts",
    status: missingScripts.length === 0 ? "PASS" : "FAIL",
    reason:
      missingScripts.length === 0 ? "all required scripts exist" : `missing scripts: ${missingScripts.join(", ")}`,
    actual: missingScripts.length === 0 ? requiredScripts.join(", ") : missingScripts.join(", "),
    expected: requiredScripts.join(", ")
  });

  const portChecks = await Promise.all([checkPort(43123), checkPort(54174)]);
  checks.push(...portChecks);

  const status = checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
  const result = {
    status,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    checks
  };
  print(result);
  if (status !== "PASS") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const result = {
    status: "FAIL",
    duration_ms: 0,
    timestamp: new Date().toISOString(),
    checks: [
      {
        id: "doctor_runtime",
        status: "FAIL",
        reason: error instanceof Error ? error.message : String(error),
        actual: "exception",
        expected: "successful execution"
      }
    ]
  };
  print(result);
  process.exitCode = 1;
});
