import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentWorkspaceError } from "./errors.mjs";
import { ensureDir, exists, readJsonFile, writeJsonFile, writeTextFile } from "./utils/file-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const staticTemplateRoot = path.resolve(packageRoot, "template-agentstatic");
const agentWorkspaceSrcRoot = path.resolve(packageRoot, "src");

function normalizeGoal(rawGoal) {
  const trimmed = typeof rawGoal === "string" ? rawGoal.trim() : "";
  return trimmed || "Build a reusable EasyAgentTeam workflow package";
}

async function copyDirectoryRecursive(sourceDir, targetDir) {
  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(sourceDir, entry.name);
    const dstPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, dstPath);
      continue;
    }
    if (entry.isFile()) {
      await ensureDir(path.dirname(dstPath));
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

async function collectStepOutputs(reportsDir) {
  if (!(await exists(reportsDir))) {
    return [];
  }
  const files = await fs.readdir(reportsDir, { withFileTypes: true });
  const grouped = new Map();
  for (const file of files) {
    if (!file.isFile()) {
      continue;
    }
    if (!file.name.startsWith("step-") || file.name.startsWith("step-00-init")) {
      continue;
    }
    const ext = path.extname(file.name).toLowerCase();
    if (ext !== ".md" && ext !== ".json") {
      continue;
    }
    const id = file.name.slice(0, -ext.length);
    if (!grouped.has(id)) {
      grouped.set(id, { step_id: id, markdown_path: null, json_path: null });
    }
    const item = grouped.get(id);
    const absolute = path.join(reportsDir, file.name);
    if (ext === ".md") {
      item.markdown_path = absolute;
    } else {
      item.json_path = absolute;
    }
  }
  return [...grouped.values()].sort((a, b) => a.step_id.localeCompare(b.step_id));
}

async function patchTemplateConfig(configPath, baseUrl) {
  if (!(await exists(configPath))) {
    return;
  }
  const config = await readJsonFile(configPath);
  config.base_url = baseUrl;
  await writeJsonFile(configPath, config);
}

async function vendorAgentWorkspaceRuntime(targetDir) {
  if (!(await exists(agentWorkspaceSrcRoot))) {
    throw new AgentWorkspaceError("agent-workspace runtime source not found", "INIT_TEMPLATE_GUARD_NOT_FOUND", {
      runtime_source: agentWorkspaceSrcRoot
    });
  }
  await copyDirectoryRecursive(agentWorkspaceSrcRoot, targetDir);
}

function buildInitMarkdown(options) {
  return [
    "# step-00-init",
    "",
    "- status: pass",
    `- workspace_root: ${options.workspaceRoot}`,
    `- template_source: ${options.templateSource}`,
    `- goal: ${options.goal}`,
    `- base_url: ${options.baseUrl}`,
    `- guard_script: ${options.guardScriptPath}`,
    `- guard_skill: ${options.guardSkillPath}`,
    ""
  ].join("\n");
}

export async function initAgentWorkspace(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  const goal = normalizeGoal(options.goal);
  const baseUrl = String(options.baseUrl || "").trim();

  if (!baseUrl) {
    throw new AgentWorkspaceError("missing required base_url for init", "INIT_INPUT_INVALID");
  }

  if (!(await exists(staticTemplateRoot))) {
    throw new AgentWorkspaceError(
        "template-agentstatic static template not found",
      "INIT_TEMPLATE_NOT_FOUND",
      {
        template_root: staticTemplateRoot
      }
    );
  }

  await ensureDir(workspaceRoot);
  await copyDirectoryRecursive(staticTemplateRoot, workspaceRoot);

  const reportsDir = path.join(workspaceRoot, "reports");
  await ensureDir(reportsDir);

  const agentsGuidePath = path.join(workspaceRoot, "AGENTS.md");
  const bundleSamplePath = path.join(workspaceRoot, "bundles", "template.bundle.sample.json");
  const configPath = path.join(workspaceRoot, ".agent-tools", "config.json");
  const guardScriptPath = path.join(workspaceRoot, ".agent-tools", "scripts", "template_bundle_guard.mjs");
  const guardRuntimePath = path.join(workspaceRoot, ".agent-tools", "agent-workspace-src");
  const guardSkillPath = path.join(
    workspaceRoot,
    ".agent-tools",
    "skills",
    "template_bundle_guard",
    "SKILL.md"
  );
  const guardReportDir = path.join(workspaceRoot, "reports", "template-guard");

  await patchTemplateConfig(configPath, baseUrl);
  await vendorAgentWorkspaceRuntime(guardRuntimePath);
  await ensureDir(guardReportDir);

  const stepOutputs = await collectStepOutputs(reportsDir);
  const initReport = {
    mode: "init",
    status: "pass",
    time: new Date().toISOString(),
    workspace_root: workspaceRoot,
    template_source: staticTemplateRoot,
    goal,
    base_url: baseUrl,
    created: {
      agents_guide_path: agentsGuidePath,
      bundle_sample_path: bundleSamplePath,
      agent_tools: {
        config_path: configPath,
        guard_script_path: guardScriptPath,
        guard_skill_path: guardSkillPath,
        guard_report_dir: guardReportDir
      },
      step_reports: stepOutputs
    }
  };

  const reportJsonPath = path.join(reportsDir, "step-00-init.json");
  const reportMdPath = path.join(reportsDir, "step-00-init.md");
  await writeJsonFile(reportJsonPath, initReport);
  await writeTextFile(
    reportMdPath,
    buildInitMarkdown({
      workspaceRoot,
      templateSource: staticTemplateRoot,
      goal,
      baseUrl,
      guardScriptPath,
      guardSkillPath
    })
  );

  return {
    mode: "init",
    status: "pass",
    workspaceRoot,
    goal,
    baseUrl,
    reportJsonPath,
    reportMdPath,
    agentsGuidePath,
    bundleSamplePath,
    templateGuard: {
      configPath,
      scriptPath: guardScriptPath,
      skillPath: guardSkillPath,
      reportDir: guardReportDir
    }
  };
}
