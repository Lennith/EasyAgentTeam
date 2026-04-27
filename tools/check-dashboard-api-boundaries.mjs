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

const forbiddenLegacyFiles = ["dashboard-v2/src/services/api/legacy.ts", "dashboard-v2/src/types/legacy.ts"];

for (const relativePath of forbiddenLegacyFiles) {
  const fullPath = path.join(repoRoot, relativePath);
  if (fs.existsSync(fullPath)) {
    failed = true;
    console.error(`[dashboard-api-boundaries] legacy file must be removed: ${relativePath}`);
  }
}

function walkFiles(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!absolute.endsWith(".ts") && !absolute.endsWith(".tsx")) continue;
    files.push(absolute);
  }
  return files;
}

const legacyImportPatterns = [
  /from\s+["']\.\/legacy["']/,
  /from\s+["']@\/types\/legacy["']/,
  /from\s+["']@\/services\/api\/legacy["']/
];

for (const file of walkFiles(path.join(repoRoot, "dashboard-v2", "src"))) {
  const content = fs.readFileSync(file, "utf8");
  const matched = legacyImportPatterns.find((pattern) => pattern.test(content));
  if (!matched) continue;
  failed = true;
  const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
  console.error(`[dashboard-api-boundaries] legacy import is forbidden: ${relative}`);
}

if (failed) {
  process.exit(1);
}

console.log("[dashboard-api-boundaries] ok");
