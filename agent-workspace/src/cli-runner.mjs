import path from "node:path";
import { loadTemplateBundle } from "./bundle-loader.mjs";
import { createRuntimeContext } from "./context.mjs";
import { runApply, runModuleCheck, runValidate } from "./engine.mjs";
import { MODULE_CHECKABLE } from "./constants.mjs";
import { AgentWorkspaceError } from "./errors.mjs";
import { initAgentWorkspace } from "./init-workspace.mjs";
import { writeReport } from "./report-writer.mjs";

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new AgentWorkspaceError("command is required: init|validate|apply|module-check", "CLI_INPUT_INVALID");
  }
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return { command, args };
}

function ensureRequired(value, name) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) {
    throw new AgentWorkspaceError(`missing required argument: --${name}`, "CLI_INPUT_INVALID");
  }
  return result;
}

export async function runCli(argv, repoRoot) {
  const { command, args } = parseArgs(argv);
  if (command === "init") {
    const goal = ensureRequired(args.goal, "goal");
    const baseUrl = ensureRequired(args["base-url"], "base-url");
    const workspaceRoot = typeof args.workspace === "string" ? args.workspace : process.cwd();
    const init = await initAgentWorkspace({
      goal,
      baseUrl,
      workspaceRoot
    });
    return {
      command,
      report: { status: "pass", mode: "init" },
      paths: { jsonPath: init.reportJsonPath, mdPath: init.reportMdPath },
      index: {
        bundle_id: null,
        project_id: null,
        template_id: null,
        run_id: null
      },
      init,
      statusCode: 0
    };
  }

  const bundlePath = ensureRequired(args.bundle, "bundle");
  const baseUrl = ensureRequired(args["base-url"], "base-url");
  const loaded = await loadTemplateBundle(bundlePath);
  const dryRun = Boolean(args["dry-run"]);

  const context = await createRuntimeContext({
    bundleId: loaded.bundleId,
    bundlePath: loaded.bundlePath,
    bundleDir: loaded.bundleDir,
    bundle: loaded.bundle,
    baseUrl,
    dryRun
  });

  let report;
  if (command === "validate") {
    report = await runValidate(context);
  } else if (command === "apply") {
    report = await runApply(context);
  } else if (command === "module-check") {
    const moduleName = ensureRequired(args.module, "module");
    if (!MODULE_CHECKABLE.has(moduleName)) {
      throw new AgentWorkspaceError(`unknown module for module-check: ${moduleName}`, "CLI_INPUT_INVALID", {
        module: moduleName
      });
    }
    report = await runModuleCheck(context, moduleName);
  } else {
    throw new AgentWorkspaceError(`unknown command: ${command}`, "CLI_INPUT_INVALID");
  }

  const paths = await writeReport(repoRoot, loaded.bundleId, report);
  const index = {
    bundle_id: loaded.bundleId,
    project_id: report.created_resources?.project_id ?? null,
    template_id: report.created_resources?.workflow_template_id ?? null,
    run_id: report.created_resources?.workflow_run_id ?? null
  };

  return {
    command,
    report,
    paths,
    index,
    statusCode: report.status === "pass" ? 0 : 1
  };
}

export function printCliSummary(result) {
  if (result.command === "init" && result.init) {
    console.log(`[agent-workspace] status=pass mode=init`);
    console.log(`[agent-workspace] workspace_root=${path.resolve(result.init.workspaceRoot)}`);
    console.log(`[agent-workspace] goal=${result.init.goal}`);
    console.log(`[agent-workspace] agents_md=${path.resolve(result.init.agentsGuidePath)}`);
    console.log(`[agent-workspace] bundle_sample=${path.resolve(result.init.bundleSamplePath)}`);
    console.log(`[agent-workspace] report_json=${path.resolve(result.paths.jsonPath)}`);
    console.log(`[agent-workspace] report_md=${path.resolve(result.paths.mdPath)}`);
    return;
  }
  console.log(`[agent-workspace] status=${result.report.status} mode=${result.report.mode}`);
  console.log(`[agent-workspace] bundle_id=${result.index.bundle_id}`);
  console.log(`[agent-workspace] project_id=${result.index.project_id ?? "n/a"}`);
  console.log(`[agent-workspace] template_id=${result.index.template_id ?? "n/a"}`);
  console.log(`[agent-workspace] run_id=${result.index.run_id ?? "n/a"}`);
  console.log(`[agent-workspace] report_json=${path.resolve(result.paths.jsonPath)}`);
  console.log(`[agent-workspace] report_md=${path.resolve(result.paths.mdPath)}`);
}
