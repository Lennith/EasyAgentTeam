#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, printCliSummary } from "./src/cli-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

try {
  const result = await runCli(process.argv.slice(2), repoRoot);
  printCliSummary(result);
  process.exitCode = result.statusCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agent-workspace] error: ${message}`);
  if (error && typeof error === "object" && "details" in error && error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
}

