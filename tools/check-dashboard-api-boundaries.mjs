#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
let failed = false;

const forbiddenFiles = [
  {
    path: "dashboard-v2/src/services/api.ts",
    message: "services API root barrel must be removed"
  },
  {
    path: "dashboard-v2/src/types/index.ts",
    message: "types root barrel must be removed"
  },
  {
    path: "dashboard-v2/src/services/api/legacy.ts",
    message: "legacy API file must be removed"
  },
  {
    path: "dashboard-v2/src/types/legacy.ts",
    message: "legacy types file must be removed"
  },
  {
    path: "dashboard-v2/src/services/api/shared/mappers.ts",
    message: "shared mapper bucket must be removed"
  },
  {
    path: "server/src/data/repository/shared/legacy-task-state.ts",
    message: "legacy task-state migration must be removed"
  }
];

for (const file of forbiddenFiles) {
  const fullPath = path.join(repoRoot, file.path);
  if (fs.existsSync(fullPath)) {
    failed = true;
    console.error(`[dashboard-api-boundaries] ${file.message}: ${file.path}`);
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
const rootBarrelImportPatterns = [
  { pattern: /from\s+["']@\/types["']/, label: "types root barrel import" },
  { pattern: /from\s+["']@\/services\/api["']/, label: "services API root barrel import" }
];
const retiredRoutePatterns = [
  { pattern: /#\/templates\b/, label: "retired #/templates route alias" },
  { pattern: /\bl1\s*===\s*["']templates["']/, label: "retired templates L1 route parser" }
];

for (const file of walkFiles(path.join(repoRoot, "dashboard-v2", "src"))) {
  const content = fs.readFileSync(file, "utf8");
  const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
  const matched = legacyImportPatterns.find((pattern) => pattern.test(content));
  if (matched) {
    failed = true;
    console.error(`[dashboard-api-boundaries] legacy import is forbidden: ${relative}`);
  }
  const rootBarrelMatch = rootBarrelImportPatterns.find((item) => item.pattern.test(content));
  if (rootBarrelMatch) {
    failed = true;
    console.error(
      `[dashboard-api-boundaries] ${rootBarrelMatch.label} is reserved for compatibility only: ${relative}`
    );
  }
  const retiredRouteMatch = retiredRoutePatterns.find((item) => item.pattern.test(content));
  if (retiredRouteMatch) {
    failed = true;
    console.error(`[dashboard-api-boundaries] ${retiredRouteMatch.label} is forbidden: ${relative}`);
  }
}

const serverForbiddenPatterns = [
  { pattern: /legacy-task-state/, label: "legacy task-state import" },
  {
    pattern: /isLegacyTraeProviderId|hasLegacyTraeAgentModelConfigs|normalizeProviderId/,
    label: "legacy provider alias helper"
  },
  { pattern: /===\s*["']trae["']|["']trae["']\s*\?/, label: "trae provider compatibility branch" }
];

for (const file of walkFiles(path.join(repoRoot, "server", "src"))) {
  const content = fs.readFileSync(file, "utf8");
  const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
  const forbiddenMatch = serverForbiddenPatterns.find((item) => item.pattern.test(content));
  if (forbiddenMatch) {
    failed = true;
    console.error(`[dashboard-api-boundaries] ${forbiddenMatch.label} is forbidden: ${relative}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("[dashboard-api-boundaries] ok");
