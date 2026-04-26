#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const checks = [
  {
    path: "dashboard-v2/src/services/api.ts",
    forbidden: [/\bfetchJSON\b/, /\bfetchText\b/, /\bfetchStream\b/, /\bmap[A-Z]/],
    message: "dashboard API root must stay a compatibility barrel"
  },
  {
    path: "dashboard-v2/src/types/index.ts",
    forbidden: [/\binterface\s+\w+/, /\btype\s+\w+\s*=/],
    message: "dashboard types root must stay a compatibility barrel"
  }
];

let failed = false;
for (const check of checks) {
  const fullPath = path.join(repoRoot, check.path);
  const content = fs.readFileSync(fullPath, "utf8");
  const matched = check.forbidden.filter((pattern) => pattern.test(content));
  if (matched.length > 0) {
    failed = true;
    console.error(`[dashboard-api-boundaries] ${check.message}: ${check.path}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("[dashboard-api-boundaries] ok");
