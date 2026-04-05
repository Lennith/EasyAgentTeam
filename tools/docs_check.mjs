import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const contractPath = path.join(repoRoot, "docs", "contracts", "api-scope.server-workflow.json");
const appPath = path.join(repoRoot, "server", "src", "app.ts");
const routesDir = path.join(repoRoot, "server", "src", "routes");
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const fileCache = new Map();

function parseRoutes(appSource) {
  const routes = new Set();
  const regex = /app\.(get|post|patch|put|delete)\("([^"]+)"/g;
  let match = regex.exec(appSource);
  while (match) {
    const method = String(match[1]).toUpperCase();
    const routePath = String(match[2]).trim();
    if (routePath.startsWith("/api/")) {
      routes.add(`${method} ${routePath}`);
    }
    match = regex.exec(appSource);
  }
  return routes;
}

async function listTsFilesRecursively(rootDir) {
  const output = [];
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".ts")) {
        output.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return output;
}

function buildPathCandidates(routePath) {
  const normalized = String(routePath ?? "").trim();
  if (!normalized) {
    return [];
  }
  const variants = new Set([normalized]);
  variants.add(normalized.replace(/:([A-Za-z0-9_]+)/g, "{$1}"));
  variants.add(normalized.replace(/:([A-Za-z0-9_]+)/g, "<$1>"));
  return [...variants];
}

function contentContainsRoutePath(content, routePath) {
  if (typeof content !== "string" || content.length === 0) {
    return false;
  }
  const candidates = buildPathCandidates(routePath);
  return candidates.some((candidate) => candidate && content.includes(candidate));
}

async function readCached(filePath) {
  if (fileCache.has(filePath)) {
    return fileCache.get(filePath);
  }
  try {
    const content = await fs.readFile(filePath, "utf8");
    const result = { exists: true, content };
    fileCache.set(filePath, result);
    return result;
  } catch {
    const result = { exists: false, content: null };
    fileCache.set(filePath, result);
    return result;
  }
}

function stringifyResult(payload) {
  if (jsonOutput) {
    return JSON.stringify(payload, null, 2);
  }
  const lines = [];
  lines.push(`status=${payload.status}`);
  lines.push(`duration_ms=${payload.duration_ms}`);
  lines.push(`checks_total=${payload.checks.length}`);
  for (const check of payload.checks) {
    lines.push(`[${check.status}] ${check.id}: ${check.reason}`);
  }
  if (payload.missing_routes.length > 0) {
    lines.push("missing_routes:");
    for (const item of payload.missing_routes) {
      lines.push(`- ${item.method} ${item.path}`);
    }
  }
  if (payload.doc_missing_refs.length > 0) {
    lines.push("doc_missing_refs:");
    for (const item of payload.doc_missing_refs) {
      lines.push(`- ${item.ref} (for ${item.method} ${item.path})`);
    }
  }
  if (payload.doc_missing_paths.length > 0) {
    lines.push("doc_missing_paths:");
    for (const item of payload.doc_missing_paths) {
      lines.push(`- ${item.refs.join(", ")} (required by ${item.method} ${item.pathRef})`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const startedAt = Date.now();
  const [contractRaw, appRaw, routeFiles] = await Promise.all([
    fs.readFile(contractPath, "utf8"),
    fs.readFile(appPath, "utf8"),
    listTsFilesRecursively(routesDir)
  ]);
  const contract = JSON.parse(contractRaw);
  const endpoints = Array.isArray(contract.endpoints) ? contract.endpoints : [];
  const routeSources = await Promise.all(routeFiles.map(async (filePath) => await fs.readFile(filePath, "utf8")));
  const routes = new Set(parseRoutes(appRaw));
  for (const routeSource of routeSources) {
    for (const route of parseRoutes(routeSource)) {
      routes.add(route);
    }
  }

  const missingRoutes = [];
  const docMissingRefs = [];
  const docMissingPaths = [];
  const checks = [];

  for (const endpoint of endpoints) {
    const method = String(endpoint.method ?? "").toUpperCase();
    const routePath = String(endpoint.path ?? "");
    if (!method || !routePath) {
      continue;
    }
    const key = `${method} ${routePath}`;
    if (!routes.has(key)) {
      missingRoutes.push({ method, path: routePath, status: endpoint.status ?? "active" });
    }

    const refs = Array.isArray(endpoint.docRefs) ? endpoint.docRefs : [];
    const existingDocContents = [];
    for (const ref of refs) {
      const absoluteRef = path.join(repoRoot, ref);
      const readResult = await readCached(absoluteRef);
      if (!readResult.exists) {
        docMissingRefs.push({ method, path: routePath, ref });
        continue;
      }
      existingDocContents.push({ ref, content: readResult.content });
    }
    if (existingDocContents.length === 0) {
      if (refs.length === 0) {
        docMissingPaths.push({ method, pathRef: routePath, refs: ["<no-docRefs>"] });
      }
      continue;
    }
    const documented = existingDocContents.some((doc) => contentContainsRoutePath(doc.content, routePath));
    if (!documented) {
      docMissingPaths.push({
        method,
        pathRef: routePath,
        refs: existingDocContents.map((doc) => doc.ref)
      });
    }
  }

  checks.push({
    id: "routes_exist_in_app",
    status: missingRoutes.length === 0 ? "PASS" : "FAIL",
    reason:
      missingRoutes.length === 0
        ? "all managed endpoints exist in server route sources"
        : `${missingRoutes.length} managed endpoint(s) missing in server route sources`
  });
  checks.push({
    id: "doc_refs_exist",
    status: docMissingRefs.length === 0 ? "PASS" : "FAIL",
    reason: docMissingRefs.length === 0 ? "all docRefs exist" : `${docMissingRefs.length} docRef file(s) missing`
  });
  checks.push({
    id: "doc_contains_path",
    status: docMissingPaths.length === 0 ? "PASS" : "FAIL",
    reason:
      docMissingPaths.length === 0
        ? "all managed endpoint paths are documented"
        : `${docMissingPaths.length} endpoint path mention(s) missing in docs`
  });

  const status = checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
  const result = {
    status,
    scope: contract.scope ?? "server-workflow",
    duration_ms: Date.now() - startedAt,
    checks,
    missing_routes: missingRoutes,
    doc_missing_refs: docMissingRefs,
    doc_missing_paths: docMissingPaths
  };

  console.log(stringifyResult(result));
  if (status !== "PASS") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const payload = {
    status: "FAIL",
    scope: "server-workflow",
    duration_ms: 0,
    checks: [
      {
        id: "docs_check_runtime",
        status: "FAIL",
        reason: error instanceof Error ? error.message : String(error)
      }
    ],
    missing_routes: [],
    doc_missing_refs: [],
    doc_missing_paths: []
  };
  console.log(stringifyResult(payload));
  process.exitCode = 1;
});
