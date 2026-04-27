#!/usr/bin/env node
import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..");
const artifactDir = path.join(repoRoot, "dist", "release_artifacts");
const sourcePackCommand = "npm pack --json";
const manifestSchemaVersion = "1.0";

await mkdir(artifactDir, { recursive: true });

function runPack() {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
    const args = process.platform === "win32" ? ["/d", "/c", sourcePackCommand] : ["pack", "--json"];
    const child = spawn(command, args, {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`package pack terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`package pack exited with code ${code ?? 1}`));
        return;
      }
      try {
        const details = JSON.parse(stdout.trim());
        const filename = details[0]?.filename;
        if (!filename) {
          reject(new Error("package pack output did not include a filename"));
          return;
        }
        resolve(filename);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("error", reject);
  });
}

async function sha256File(absolutePath) {
  const content = await readFile(absolutePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

try {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageName = String(packageJson.name ?? "");
  const packageVersion = String(packageJson.version ?? "");
  if (!packageName || !packageVersion) {
    throw new Error("package.json missing required name/version");
  }

  const filename = await runPack();
  const sourcePath = path.join(packageRoot, filename);
  const targetPath = path.join(artifactDir, filename);
  await rm(targetPath, { force: true });
  await rename(sourcePath, targetPath);
  const artifactStat = await stat(targetPath);
  const artifactSha256 = await sha256File(targetPath);
  const generatedAt = new Date().toISOString();
  const manifest = {
    schema_version: manifestSchemaVersion,
    package_name: packageName,
    package_version: packageVersion,
    artifact_file: filename,
    artifact_path: targetPath,
    artifact_size_bytes: artifactStat.size,
    artifact_sha256: artifactSha256,
    generated_at: generatedAt,
    generated_by: "pnpm agent-workspace:pack",
    source_command: sourcePackCommand,
    verify_command: "pnpm agent-workspace:verify"
  };
  const manifestPath = path.join(artifactDir, `${filename}.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[agent-workspace:pack] artifact=${targetPath}`);
  console.log(`[agent-workspace:pack] manifest=${manifestPath}`);
} catch (error) {
  console.error(`[agent-workspace:pack] failed to create package artifact: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
