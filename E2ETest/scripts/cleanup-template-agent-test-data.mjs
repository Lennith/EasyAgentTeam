#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultPrefixes = ["mkt01_", "rh02_", "fn03_", "pc04_", "e2e_", "ext", "campaign"];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = String(next);
    index += 1;
  }
  return args;
}

function nowStamp() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function isInsideRepo(candidatePath) {
  const relative = path.relative(repoRoot, candidatePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function exists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(absolutePath, fallback = null) {
  if (!(await exists(absolutePath))) {
    return fallback;
  }
  const raw = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(absolutePath, payload) {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function startsWithPrefix(value, prefixes) {
  const text = String(value ?? "");
  return prefixes.some((prefix) => text.startsWith(prefix));
}

function normalizePrefixes(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return defaultPrefixes;
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : defaultPrefixes;
}

function ensureSafePath(absolutePath) {
  const resolved = path.resolve(absolutePath);
  if (!isInsideRepo(resolved)) {
    throw new Error(`Refuse to operate path outside repo root: ${resolved}`);
  }
  return resolved;
}

async function removePath(absolutePath, dryRun, removed, skipped, errors) {
  const safePath = ensureSafePath(absolutePath);
  if (!(await exists(safePath))) {
    skipped.push({ type: "path", path: safePath, reason: "not_found" });
    return;
  }
  if (dryRun) {
    removed.push({ type: "path", path: safePath, dry_run: true });
    return;
  }
  try {
    await fs.rm(safePath, { recursive: true, force: true });
    removed.push({ type: "path", path: safePath, dry_run: false });
  } catch (error) {
    errors.push({ type: "path", path: safePath, message: error instanceof Error ? error.message : String(error) });
  }
}

function pruneArrayByPrefix(items, idAccessor, prefixes) {
  const kept = [];
  const removed = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(idAccessor(item) ?? "");
    if (startsWithPrefix(id, prefixes)) {
      removed.push(item);
    } else {
      kept.push(item);
    }
  }
  return { kept, removed };
}

async function updateJsonFile(absolutePath, updater, dryRun, changed, errors) {
  const safePath = ensureSafePath(absolutePath);
  try {
    const original = await readJson(safePath, null);
    if (original === null) {
      return { original: null, updated: null, wrote: false };
    }
    const updated = updater(structuredClone(original));
    const originalText = JSON.stringify(original);
    const updatedText = JSON.stringify(updated);
    if (originalText === updatedText) {
      return { original, updated, wrote: false };
    }
    changed.push({ path: safePath, dry_run: dryRun });
    if (!dryRun) {
      await writeJson(safePath, updated);
    }
    return { original, updated, wrote: true };
  } catch (error) {
    errors.push({ type: "json", path: safePath, message: error instanceof Error ? error.message : String(error) });
    return { original: null, updated: null, wrote: false };
  }
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Template Agent Cleanup Report");
  lines.push("");
  lines.push(`- generated_at: ${report.generated_at}`);
  lines.push(`- dry_run: ${report.dry_run}`);
  lines.push(`- prefixes: ${report.prefixes.join(", ")}`);
  lines.push(`- removed_count: ${report.removed.length}`);
  lines.push(`- skipped_count: ${report.skipped.length}`);
  lines.push(`- changed_json_count: ${report.changed_json.length}`);
  lines.push(`- errors_count: ${report.errors.length}`);
  lines.push("");
  lines.push("## Removed");
  if (report.removed.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of report.removed) {
      if (item.type === "path") {
        lines.push(`- path: ${item.path} ${item.dry_run ? "(dry-run)" : ""}`);
      } else {
        lines.push(`- ${item.type}: ${item.id} ${item.dry_run ? "(dry-run)" : ""}`);
      }
    }
  }
  lines.push("");
  lines.push("## Changed JSON");
  if (report.changed_json.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of report.changed_json) {
      lines.push(`- ${item.path} ${item.dry_run ? "(dry-run)" : ""}`);
    }
  }
  lines.push("");
  if (report.errors.length > 0) {
    lines.push("## Errors");
    for (const err of report.errors) {
      lines.push(`- [${err.type}] ${err.path || err.id || "n/a"}: ${err.message}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !Boolean(args.confirm);
  const prefixes = normalizePrefixes(args.prefixes);
  const stamp = nowStamp();

  const removed = [];
  const skipped = [];
  const changedJson = [];
  const errors = [];

  const pathTargets = [
    path.resolve(repoRoot, "server", "workspace"),
    path.resolve(repoRoot, ".e2e-workspace", "TestTeam"),
    path.resolve(repoRoot, "docs", "e2e"),
    path.resolve(repoRoot, "agent-workspace", "reports")
  ];

  for (const target of pathTargets) {
    await removePath(target, dryRun, removed, skipped, errors);
  }

  const dataRoot = path.resolve(repoRoot, "data");
  const projectRoot = path.join(dataRoot, "projects");
  if (await exists(projectRoot)) {
    const projectDirs = await fs.readdir(projectRoot, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (startsWithPrefix(entry.name, prefixes)) {
        await removePath(path.join(projectRoot, entry.name), dryRun, removed, skipped, errors);
      }
    }
  }

  const templatesJsonPath = path.join(dataRoot, "workflows", "templates.json");
  const runsJsonPath = path.join(dataRoot, "workflows", "runs.json");
  const agentsRegistryPath = path.join(dataRoot, "agents", "registry.json");
  const skillsRegistryPath = path.join(dataRoot, "skills", "registry.json");
  const skillListsPath = path.join(dataRoot, "skills", "lists.json");

  const removedTemplateIds = new Set();
  const removedRunIds = new Set();
  const removedAgentIds = new Set();
  const removedSkillIds = new Set();
  const removedSkillPackagePaths = new Set();

  await updateJsonFile(
    templatesJsonPath,
    (json) => {
      const templates = Array.isArray(json?.templates) ? json.templates : [];
      const { kept, removed: removedItems } = pruneArrayByPrefix(templates, (item) => item?.templateId, prefixes);
      for (const item of removedItems) {
        removedTemplateIds.add(String(item?.templateId ?? ""));
      }
      json.templates = kept;
      json.updatedAt = new Date().toISOString();
      return json;
    },
    dryRun,
    changedJson,
    errors
  );

  await updateJsonFile(
    runsJsonPath,
    (json) => {
      const runs = Array.isArray(json?.runs) ? json.runs : [];
      const kept = [];
      for (const run of runs) {
        const runId = String(run?.runId ?? "");
        const templateId = String(run?.templateId ?? "");
        if (startsWithPrefix(runId, prefixes) || startsWithPrefix(templateId, prefixes)) {
          removedRunIds.add(runId);
          continue;
        }
        kept.push(run);
      }
      json.runs = kept;
      json.updatedAt = new Date().toISOString();
      return json;
    },
    dryRun,
    changedJson,
    errors
  );

  const runDirRoot = path.join(dataRoot, "workflows", "runs");
  if (await exists(runDirRoot)) {
    const runDirs = await fs.readdir(runDirRoot, { withFileTypes: true });
    for (const entry of runDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (startsWithPrefix(entry.name, prefixes) || removedRunIds.has(entry.name)) {
        await removePath(path.join(runDirRoot, entry.name), dryRun, removed, skipped, errors);
      }
    }
  }

  await updateJsonFile(
    agentsRegistryPath,
    (json) => {
      const agents = Array.isArray(json?.agents) ? json.agents : [];
      const { kept, removed: removedItems } = pruneArrayByPrefix(agents, (item) => item?.agentId, prefixes);
      for (const item of removedItems) {
        removedAgentIds.add(String(item?.agentId ?? ""));
      }
      json.agents = kept;
      json.updatedAt = new Date().toISOString();
      return json;
    },
    dryRun,
    changedJson,
    errors
  );

  await updateJsonFile(
    skillsRegistryPath,
    (json) => {
      const skills = Array.isArray(json?.skills) ? json.skills : [];
      const kept = [];
      for (const skill of skills) {
        const skillId = String(skill?.skillId ?? "");
        if (startsWithPrefix(skillId, prefixes)) {
          removedSkillIds.add(skillId);
          if (typeof skill?.packagePath === "string" && skill.packagePath.trim()) {
            removedSkillPackagePaths.add(skill.packagePath.trim());
          }
          continue;
        }
        kept.push(skill);
      }
      json.skills = kept;
      json.updatedAt = new Date().toISOString();
      return json;
    },
    dryRun,
    changedJson,
    errors
  );

  await updateJsonFile(
    skillListsPath,
    (json) => {
      const lists = Array.isArray(json?.lists) ? json.lists : [];
      const kept = [];
      for (const list of lists) {
        const listId = String(list?.listId ?? "");
        if (startsWithPrefix(listId, prefixes)) {
          continue;
        }
        const skillIds = Array.isArray(list?.skillIds) ? list.skillIds : [];
        list.skillIds = skillIds.filter((skillId) => !removedSkillIds.has(String(skillId)));
        kept.push(list);
      }
      json.lists = kept;
      json.updatedAt = new Date().toISOString();
      return json;
    },
    dryRun,
    changedJson,
    errors
  );

  for (const packageRelPath of removedSkillPackagePaths) {
    const packagePath = path.join(dataRoot, "skills", packageRelPath);
    await removePath(packagePath, dryRun, removed, skipped, errors);
  }

  for (const id of removedTemplateIds) {
    removed.push({ type: "workflow_template", id, dry_run: dryRun });
  }
  for (const id of removedRunIds) {
    removed.push({ type: "workflow_run", id, dry_run: dryRun });
  }
  for (const id of removedAgentIds) {
    removed.push({ type: "agent", id, dry_run: dryRun });
  }
  for (const id of removedSkillIds) {
    removed.push({ type: "skill", id, dry_run: dryRun });
  }

  const reportDir = path.resolve(repoRoot, "docs", "e2e", "cleanup", stamp);
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    prefixes,
    repo_root: repoRoot,
    removed,
    skipped,
    changed_json: changedJson,
    errors
  };

  await writeJson(path.join(reportDir, "cleanup_report.json"), report);
  await fs.writeFile(path.join(reportDir, "cleanup_report.md"), toMarkdown(report), "utf8");

  console.log(`[cleanup] dry_run=${dryRun}`);
  console.log(`[cleanup] removed=${removed.length} skipped=${skipped.length} changed_json=${changedJson.length} errors=${errors.length}`);
  console.log(`[cleanup] report_json=${path.join(reportDir, "cleanup_report.json")}`);
  console.log(`[cleanup] report_md=${path.join(reportDir, "cleanup_report.md")}`);

  if (errors.length > 0) {
    process.exitCode = 2;
    return;
  }
  process.exitCode = 0;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[cleanup] error: ${message}`);
  process.exitCode = 2;
});
