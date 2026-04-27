#!/usr/bin/env node
import crypto from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..");
const artifactDir = path.join(repoRoot, "dist", "release_artifacts");
const workingDir = process.cwd();

function parseArgs(argv) {
  const args = {
    manifestPath: "",
    keepTemp: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") {
      args.manifestPath = argv[index + 1] ? String(argv[index + 1]) : "";
      index += 1;
      continue;
    }
    if (token === "--keep-temp") {
      args.keepTemp = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function runCommand(commandLine, cwd) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "sh";
    const args = process.platform === "win32" ? ["/d", "/c", commandLine] : ["-lc", commandLine];
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit"
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`command terminated by ${signal}: ${commandLine}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`command exited with code ${code ?? 1}: ${commandLine}`));
        return;
      }
      resolve();
    });
    child.on("error", reject);
  });
}

async function sha256File(absolutePath) {
  const content = await readFile(absolutePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function resolveManifestPath(explicitPath) {
  if (explicitPath) {
    return path.resolve(workingDir, explicitPath);
  }
  const entries = await readdir(artifactDir, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".manifest.json")) continue;
    const absolute = path.join(artifactDir, entry.name);
    const info = await stat(absolute);
    manifests.push({ absolute, modifiedAt: info.mtimeMs });
  }
  manifests.sort((left, right) => right.modifiedAt - left.modifiedAt);
  if (manifests.length === 0) {
    throw new Error("no artifact manifest found; run `pnpm agent-workspace:pack` first");
  }
  return manifests[0].absolute;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = await resolveManifestPath(args.manifestPath);
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const artifactFile = String(manifest.artifact_file ?? "");
  const artifactPathFromManifest = String(manifest.artifact_path ?? "");
  const expectedSha = String(manifest.artifact_sha256 ?? "");
  const expectedSize = Number(manifest.artifact_size_bytes ?? 0);
  if (!artifactFile || !expectedSha || !Number.isFinite(expectedSize) || expectedSize <= 0) {
    throw new Error(`invalid manifest: ${manifestPath}`);
  }
  const artifactPath = artifactPathFromManifest
    ? path.resolve(artifactPathFromManifest)
    : path.join(artifactDir, artifactFile);

  await access(artifactPath);
  const artifactStat = await stat(artifactPath);
  if (artifactStat.size !== expectedSize) {
    throw new Error(`artifact size mismatch: manifest=${expectedSize} actual=${artifactStat.size}`);
  }
  const actualSha = await sha256File(artifactPath);
  if (actualSha !== expectedSha) {
    throw new Error(`artifact sha256 mismatch: manifest=${expectedSha} actual=${actualSha}`);
  }
  console.log(`[agent-workspace:verify] checksum=ok manifest=${manifestPath}`);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-verify-"));
  let keepTemp = args.keepTemp;
  try {
    await runCommand("npm init -y", tempRoot);
    await runCommand(`npm install ${artifactPath} --no-package-lock`, tempRoot);
    const smokeWorkspace = path.join(tempRoot, "agent-workspace-smoke");
    await runCommand(
      `npx --no-install agent-workspace init --goal verify-smoke --base-url http://127.0.0.1:43123 --workspace ${smokeWorkspace}`,
      tempRoot
    );
    console.log(`[agent-workspace:verify] smoke=ok temp=${tempRoot}`);
    keepTemp = false;
  } catch (error) {
    keepTemp = true;
    throw error;
  } finally {
    if (keepTemp) {
      console.warn(`[agent-workspace:verify] temp preserved: ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(`[agent-workspace:verify] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
