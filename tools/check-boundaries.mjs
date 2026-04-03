import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const jsonOutput = args.has("--json");
const repoRoot = process.cwd();

async function listFilesRecursively(rootDir, extension = ".ts") {
  const files = [];
  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(extension)) {
        files.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return files;
}

function findLineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

async function findPatternHits(files, patterns) {
  const hits = [];
  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match = pattern.regex.exec(source);
      while (match) {
        hits.push({
          file: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
          line: findLineNumber(source, match.index),
          rule: pattern.label,
          snippet: match[0]
        });
        match = pattern.regex.exec(source);
      }
    }
  }
  return hits;
}

async function checkRouteNoTransactionEntry() {
  const routeFiles = await listFilesRecursively(path.join(repoRoot, "server", "src", "routes"));
  const warnings = await findPatternHits(routeFiles, [
    { label: "route_should_not_call_runInUnitOfWork", regex: /\brunInUnitOfWork\s*\(/g },
    { label: "route_should_not_call_runWithResolvedScope", regex: /\brunWithResolvedScope\s*\(/g },
    { label: "route_should_not_call_unitOfWorkRun", regex: /\bUnitOfWork\.run\s*\(/g },
    {
      label: "route_should_not_import_data_repository",
      regex: /from\s+["'][^"']*\/data\/repository\/[^"']*["']/g
    },
    {
      label: "route_should_not_import_data_store_or_storage",
      regex: /from\s+["'][^"']*\/data\/(store|storage)\/[^"']*["']/g
    },
    {
      label: "route_should_not_import_data_file_utils",
      regex: /from\s+["'][^"']*\/data\/file-utils["']/g
    }
  ]);
  return {
    id: "storage_route_boundary",
    description: "route 层不得直接开启或持有事务边界",
    warnings
  };
}

async function checkServiceNoDirectStoreStorage() {
  const serviceFiles = await listFilesRecursively(path.join(repoRoot, "server", "src", "services"));
  const warnings = await findPatternHits(serviceFiles, [
    {
      label: "service_should_not_import_data_store_or_storage",
      regex: /from\s+["'][^"']*\/data\/(store|storage)\/[^"']*["']/g
    },
    {
      label: "service_should_not_import_data_file_utils",
      regex: /from\s+["'][^"']*\/data\/file-utils["']/g
    }
  ]);
  return {
    id: "storage_service_boundary",
    description: "service 主链路应通过 repository bundle，不直连 store/storage/file-utils",
    warnings
  };
}

async function checkRepositoryBundleScopeSeams() {
  const requiredSeams = [
    { key: "resolveScope", regex: /\bresolveScope(?:<[^>]+>)?\s*\(/ },
    { key: "runInUnitOfWork", regex: /\brunInUnitOfWork(?:<[^>]+>)?\s*\(/ },
    { key: "runWithResolvedScope", regex: /\brunWithResolvedScope(?:<[^>]+>)?\s*\(/ }
  ];
  const files = [
    path.join(repoRoot, "server", "src", "data", "repository", "project-repository-bundle.ts"),
    path.join(repoRoot, "server", "src", "data", "repository", "workflow-repository-bundle.ts")
  ];
  const warnings = [];
  for (const filePath of files) {
    let source = "";
    try {
      source = await fs.readFile(filePath, "utf8");
    } catch {
      warnings.push({
        file: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
        line: 1,
        rule: "repository_bundle_file_missing",
        snippet: "file_not_found"
      });
      continue;
    }
    for (const seam of requiredSeams) {
      if (!seam.regex.test(source)) {
        warnings.push({
          file: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
          line: 1,
          rule: "repository_bundle_scope_seam_missing",
          snippet: seam.key
        });
      }
    }
  }
  return {
    id: "storage_scope_contract",
    description: "Project/Workflow repository bundle 必须同时暴露三段 scope seam",
    warnings
  };
}

async function checkOrchestratorSharedFreezeNames() {
  const sharedDir = path.join(repoRoot, "server", "src", "services", "orchestrator", "shared");
  const files = await listFilesRecursively(sharedDir);
  const allowedNamedSeams = new Set(["contracts.ts", "manager-message-contract.ts", "orchestrator-runtime-helpers.ts"]);
  const warnings = [];
  for (const filePath of files) {
    const basename = path.basename(filePath);
    if (!/(contract|helper|compat)/i.test(basename)) {
      continue;
    }
    if (allowedNamedSeams.has(basename)) {
      continue;
    }
    warnings.push({
      file: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
      line: 1,
      rule: "orchestrator_shared_forbidden_named_seam",
      snippet: basename
    });
  }
  return {
    id: "orchestrator_shared_freeze",
    description: "shared 冻结期间不新增 contract/helper/compat 命名 seam",
    warnings
  };
}

async function checkOrchestratorFacadeNoUow() {
  const entryFiles = [
    path.join(repoRoot, "server", "src", "services", "orchestrator", "project-orchestrator.ts"),
    path.join(repoRoot, "server", "src", "services", "orchestrator", "workflow-orchestrator.ts")
  ];
  const warnings = await findPatternHits(entryFiles, [
    { label: "orchestrator_facade_should_not_call_runInUnitOfWork", regex: /\brunInUnitOfWork\s*\(/g },
    { label: "orchestrator_facade_should_not_call_runWithResolvedScope", regex: /\brunWithResolvedScope\s*\(/g },
    { label: "orchestrator_facade_should_not_call_unitOfWorkRun", regex: /\bUnitOfWork\.run\s*\(/g }
  ]);
  return {
    id: "orchestrator_facade_boundary",
    description: "orchestrator entry 应保持 facade，不直接下沉事务执行",
    warnings
  };
}

function toPrintable(result) {
  if (jsonOutput) {
    return JSON.stringify(result, null, 2);
  }
  const lines = [];
  lines.push(`status=${result.status}`);
  lines.push(`strict=${result.strict}`);
  lines.push(`checks_total=${result.checks.length}`);
  lines.push(`warnings_total=${result.warning_count}`);
  for (const check of result.checks) {
    const status = check.warnings.length === 0 ? "PASS" : "WARN";
    lines.push(`[${status}] ${check.id}: ${check.description} (warnings=${check.warnings.length})`);
    for (const warning of check.warnings) {
      lines.push(`- ${warning.file}:${warning.line} ${warning.rule} -> ${warning.snippet}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const checks = await Promise.all([
    checkRouteNoTransactionEntry(),
    checkServiceNoDirectStoreStorage(),
    checkRepositoryBundleScopeSeams(),
    checkOrchestratorSharedFreezeNames(),
    checkOrchestratorFacadeNoUow()
  ]);
  const warningCount = checks.reduce((sum, item) => sum + item.warnings.length, 0);
  const status = warningCount === 0 ? "PASS" : strict ? "FAIL" : "WARN";
  const result = {
    status,
    strict,
    warning_count: warningCount,
    checks
  };
  console.log(toPrintable(result));
  if (strict && warningCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[check-boundaries] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
