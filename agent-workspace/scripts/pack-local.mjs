#!/usr/bin/env node
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..");
const artifactDir = path.join(repoRoot, "dist", "release_artifacts");

await mkdir(artifactDir, { recursive: true });

function runPack() {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
    const args = process.platform === "win32" ? ["/d", "/c", "npm pack --json"] : ["pack", "--json"];
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

try {
  const filename = await runPack();
  const sourcePath = path.join(packageRoot, filename);
  const targetPath = path.join(artifactDir, filename);
  await rm(targetPath, { force: true });
  await rename(sourcePath, targetPath);
  console.log(`[agent-workspace:pack] artifact=${targetPath}`);
} catch (error) {
  console.error(`[agent-workspace:pack] failed to create package artifact: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
