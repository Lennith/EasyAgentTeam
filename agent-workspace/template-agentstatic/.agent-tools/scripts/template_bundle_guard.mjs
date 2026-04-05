#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..", "..");
const fromEnv = process.env.EASYAGENTTEAM_ROOT
  ? path.resolve(process.env.EASYAGENTTEAM_ROOT, "agent-workspace", "src", "template-bundle-guard.mjs")
  : "";
const candidates = [];
if (fromEnv) candidates.push(fromEnv);
let probe = workspaceRoot;
for (let i = 0; i < 10; i += 1) {
  candidates.push(path.resolve(probe, "agent-workspace", "src", "template-bundle-guard.mjs"));
  const parent = path.dirname(probe);
  if (parent === probe) break;
  probe = parent;
}
const modulePath = candidates.find((item) => item && fs.existsSync(item));
if (!modulePath) {
  throw new Error("Cannot locate agent-workspace/src/template-bundle-guard.mjs. Set EASYAGENTTEAM_ROOT to repository root.");
}
const guard = await import(pathToFileURL(modulePath).href);
const exitCode = await guard.runTemplateBundleGuardCli(process.argv.slice(2), { workspaceRoot });
process.exitCode = Number.isFinite(Number(exitCode)) ? Number(exitCode) : 1;
