import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const jsonOutput = args.has("--json");
const repoRoot = process.cwd();

async function listFilesRecursively(rootDir, extensions = [".ts"]) {
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
      if (entry.isFile() && extensions.some((extension) => fullPath.endsWith(extension))) {
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

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
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
          file: repoRelative(filePath),
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

async function checkRouteBoundaries() {
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
      label: "route_should_not_import_deleted_store_entry",
      regex: /from\s+["'][^"']*\/data\/[^/"']+-store\.(?:js|ts)["']/g
    },
    {
      label: "route_should_not_import_internal_persistence",
      regex: /from\s+["'][^"']*\/data\/internal\/persistence\/[^"']*["']/g
    }
  ]);

  return {
    id: "route_storage_boundary",
    description: "Routes must stay above repository and internal persistence seams.",
    warnings
  };
}

async function checkServiceBoundaries() {
  const serviceFiles = await listFilesRecursively(path.join(repoRoot, "server", "src", "services"));
  const warnings = await findPatternHits(serviceFiles, [
    {
      label: "service_should_not_import_deleted_store_entry",
      regex: /from\s+["'][^"']*\/data\/[^/"']+-store\.(?:js|ts)["']/g
    },
    {
      label: "service_should_not_import_legacy_store_directory",
      regex: /from\s+["'][^"']*\/data\/(store|storage)\/[^"']*["']/g
    },
    {
      label: "service_should_not_import_internal_persistence",
      regex: /from\s+["'][^"']*\/data\/internal\/persistence\/[^"']*["']/g
    },
    {
      label: "service_should_not_import_data_file_utils",
      regex: /from\s+["'][^"']*\/data\/file-utils(?:\.(?:js|ts))?["']/g
    }
  ]);

  return {
    id: "service_storage_boundary",
    description: "Services may depend on repositories, not deleted store seams or internal persistence code.",
    warnings
  };
}

async function checkDeletedStoreImports() {
  const sourceFiles = await listFilesRecursively(path.join(repoRoot, "server", "src"));
  const warnings = await findPatternHits(sourceFiles, [
    {
      label: "deleted_top_level_store_import",
      regex: /["'][^"']*\/data\/[^/"']+-store\.(?:js|ts)["']/g
    }
  ]);

  return {
    id: "deleted_store_entries",
    description: "Top-level data/*-store entry points must stay deleted.",
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
    path.join(repoRoot, "server", "src", "data", "repository", "project", "repository-bundle.ts"),
    path.join(repoRoot, "server", "src", "data", "repository", "workflow", "repository-bundle.ts")
  ];
  const warnings = [];

  for (const filePath of files) {
    let source = "";
    try {
      source = await fs.readFile(filePath, "utf8");
    } catch {
      warnings.push({
        file: repoRelative(filePath),
        line: 1,
        rule: "repository_bundle_file_missing",
        snippet: "file_not_found"
      });
      continue;
    }

    for (const seam of requiredSeams) {
      if (!seam.regex.test(source)) {
        warnings.push({
          file: repoRelative(filePath),
          line: 1,
          rule: "repository_bundle_scope_seam_missing",
          snippet: seam.key
        });
      }
    }
  }

  return {
    id: "repository_bundle_scope_contract",
    description: "Project and workflow repository bundles must expose the scope seams.",
    warnings
  };
}

async function checkRepositoryRootLayout() {
  const rootDir = path.join(repoRoot, "server", "src", "data", "repository");
  const warnings = [];
  let entries = [];

  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return {
      id: "repository_root_layout",
      description: "Repository root must contain only domain directories.",
      warnings: [
        {
          file: "server/src/data/repository",
          line: 1,
          rule: "repository_root_missing",
          snippet: "directory_not_found"
        }
      ]
    };
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      warnings.push({
        file: "server/src/data/repository",
        line: 1,
        rule: "repository_root_file_forbidden",
        snippet: entry.name
      });
    }
  }

  return {
    id: "repository_root_layout",
    description: "Repository root must contain only domain directories.",
    warnings
  };
}

async function checkOrchestratorRootLayout() {
  const rootDir = path.join(repoRoot, "server", "src", "services", "orchestrator");
  const allowedDirs = new Set(["project", "shared", "workflow"]);
  const warnings = [];
  let entries = [];

  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return {
      id: "orchestrator_root_layout",
      description: "Orchestrator root must contain only index.ts and project/workflow/shared.",
      warnings: [
        {
          file: "server/src/services/orchestrator",
          line: 1,
          rule: "orchestrator_root_missing",
          snippet: "directory_not_found"
        }
      ]
    };
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      if (entry.name !== "index.ts") {
        warnings.push({
          file: "server/src/services/orchestrator",
          line: 1,
          rule: /^project-|^workflow-/.test(entry.name)
            ? "orchestrator_root_domain_file_forbidden"
            : "orchestrator_root_file_forbidden",
          snippet: entry.name
        });
      }
      continue;
    }

    if (entry.isDirectory() && !allowedDirs.has(entry.name)) {
      warnings.push({
        file: "server/src/services/orchestrator",
        line: 1,
        rule: "orchestrator_root_directory_forbidden",
        snippet: entry.name
      });
    }
  }

  return {
    id: "orchestrator_root_layout",
    description: "Orchestrator root must contain only index.ts and project/workflow/shared.",
    warnings
  };
}

async function checkOrchestratorThinWrapperNames() {
  const orchestratorFiles = await listFilesRecursively(
    path.join(repoRoot, "server", "src", "services", "orchestrator")
  );
  const allowlist = new Set([
    "project/project-dispatch-session-helper.ts",
    "shared/dispatch-selection-support.ts",
    "shared/orchestrator-runtime-helpers.ts",
    "workflow/workflow-runtime-support-service.ts",
    "workflow/workflow-runtime-view.ts"
  ]);
  const warnings = [];

  for (const filePath of orchestratorFiles) {
    const relative = path
      .relative(path.join(repoRoot, "server", "src", "services", "orchestrator"), filePath)
      .replaceAll("\\", "/");
    const basename = path.basename(filePath);

    if (!/(helper|support|view)/i.test(basename)) {
      continue;
    }
    if (allowlist.has(relative)) {
      continue;
    }

    warnings.push({
      file: repoRelative(filePath),
      line: 1,
      rule: "orchestrator_thin_wrapper_name_forbidden",
      snippet: basename
    });
  }

  return {
    id: "orchestrator_thin_wrapper_names",
    description: "Thin helper/support/view naming is blocked outside the explicit allowlist.",
    warnings
  };
}

async function checkOrchestratorFacadeNoUow() {
  const entryFiles = [
    path.join(repoRoot, "server", "src", "services", "orchestrator", "project", "project-orchestrator.ts"),
    path.join(repoRoot, "server", "src", "services", "orchestrator", "workflow", "workflow-orchestrator.ts")
  ];
  const warnings = await findPatternHits(entryFiles, [
    { label: "orchestrator_facade_should_not_call_runInUnitOfWork", regex: /\brunInUnitOfWork\s*\(/g },
    { label: "orchestrator_facade_should_not_call_runWithResolvedScope", regex: /\brunWithResolvedScope\s*\(/g },
    { label: "orchestrator_facade_should_not_call_unitOfWorkRun", regex: /\bUnitOfWork\.run\s*\(/g }
  ]);

  return {
    id: "orchestrator_facade_boundary",
    description: "Project and workflow orchestrator entry files must stay as facades.",
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
    checkRouteBoundaries(),
    checkServiceBoundaries(),
    checkDeletedStoreImports(),
    checkRepositoryBundleScopeSeams(),
    checkRepositoryRootLayout(),
    checkOrchestratorRootLayout(),
    checkOrchestratorThinWrapperNames(),
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
