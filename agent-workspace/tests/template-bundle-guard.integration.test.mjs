import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../../server/src/app.ts";
import { startTestHttpServer } from "../../server/src/__tests__/helpers/http-test-server.ts";
import { initAgentWorkspace } from "../src/init-workspace.mjs";

function runNode(cwd, args, env = undefined) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, shell: false, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code: Number(code ?? 0), stdout, stderr });
    });
  });
}

async function writeJson(absolutePath, payload) {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function createSkillSource(workspaceRoot) {
  const skillDir = path.join(workspaceRoot, "skills", "guard_toolkit");
  await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: tg_guard_toolkit
description: guard toolkit skill
license: MIT
compatibility: local
---

# tg_guard_toolkit
`,
    "utf8"
  );
  await fs.writeFile(path.join(skillDir, "assets", "readme.txt"), "asset", "utf8");
}

function buildBundle(prefix, workspacePath, invalidPrompt) {
  return {
    bundle_id: `${prefix}_bundle`,
    skills_sources: ["../skills/guard_toolkit"],
    skill_lists: [
      {
        list_id: `${prefix}_skill_list`,
        display_name: "guard list",
        include_all: false,
        skill_ids: ["tg_guard_toolkit"]
      }
    ],
    agents: [
      {
        agent_id: `${prefix}_planner`,
        prompt: invalidPrompt
          ? "temporary prompt"
          : "Role Function: planning and scope decomposition. Usable Tools: requirement docs and checklist. Method: milestone-first planning.",
        skill_list: [`${prefix}_skill_list`]
      },
      {
        agent_id: `${prefix}_executor`,
        prompt:
          "Role Function: execute scoped tasks and produce artifacts. Usable Tools: workspace files and scripts. Method: incremental delivery.",
        skill_list: [`${prefix}_skill_list`]
      },
      {
        agent_id: `${prefix}_qa_guard`,
        prompt:
          "Role Function: own acceptance review and final gate decision. Usable Tools: checklist and report review. Method: criteria-first QA.",
        skill_list: [`${prefix}_skill_list`]
      }
    ],
    project: {
      project_id: `${prefix}_project`,
      name: "guard project",
      workspace_path: workspacePath,
      agent_ids: [`${prefix}_planner`, `${prefix}_executor`, `${prefix}_qa_guard`],
      route_table: {
        [`${prefix}_planner`]: [`${prefix}_executor`, `${prefix}_qa_guard`],
        [`${prefix}_executor`]: [`${prefix}_qa_guard`],
        [`${prefix}_qa_guard`]: [`${prefix}_planner`]
      },
      task_assign_route_table: {
        [`${prefix}_planner`]: [`${prefix}_executor`, `${prefix}_qa_guard`]
      }
    },
    workflow_template: {
      template_id: `${prefix}_template`,
      name: "guard workflow",
      tasks: [
        {
          task_id: "phase_plan",
          title: "Plan",
          owner_role: `${prefix}_planner`,
          acceptance: [
            "objective: lock scope",
            "input: requirements and constraints",
            "output: planning summary",
            "constraints: no implementation in this phase",
            "exception: unresolved assumptions are recorded",
            "verification: acceptance criteria are explicit"
          ],
          artifacts: ["workspace/plan/summary.md"],
          write_set: ["workspace/plan/**"]
        },
        {
          task_id: "phase_execute",
          title: "Execute",
          owner_role: `${prefix}_executor`,
          dependencies: ["phase_plan"],
          acceptance: [
            "objective: produce implementation artifacts",
            "input: approved planning summary",
            "output: execution result and evidence",
            "constraints: remain in scope",
            "exception: blockers include fallback plan",
            "verification: outputs map to acceptance criteria"
          ],
          artifacts: ["workspace/exec/result.md"],
          write_set: ["workspace/exec/**"]
        },
        {
          task_id: "phase_qa",
          title: "QA",
          owner_role: `${prefix}_qa_guard`,
          dependencies: ["phase_execute"],
          acceptance: [
            "objective: final quality decision",
            "input: planning and execution artifacts",
            "output: final QA decision",
            "constraints: independent review",
            "exception: failed criteria include fix advice",
            "verification: pass or fail rationale is explicit"
          ],
          artifacts: ["workspace/qa/final.md"],
          write_set: ["workspace/qa/**"]
        }
      ]
    },
    workflow_run: {
      run_id: `${prefix}_run`,
      template_id: `${prefix}_template`,
      workspace_path: workspacePath,
      auto_start: false
    }
  };
}

async function apiJson(baseUrl, method, routePath, body, expectedStatus = [200]) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  if (!expectedStatus.includes(response.status)) {
    throw new Error(`${method} ${routePath} expected ${expectedStatus.join("/")} got ${response.status}`);
  }
  return payload;
}

test("template_bundle_guard skill performs check/publish and blocks publish on check failure", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-template-guard-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "external-agent-workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);

  try {
    const initResult = await initAgentWorkspace({
      goal: "Generate a workflow and submit through template_bundle_guard skill",
      baseUrl: server.baseUrl,
      workspaceRoot
    });
    assert.equal(initResult.status, "pass");

    const agentsGuide = await fs.readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8");
    assert.equal(agentsGuide.includes("template_bundle_guard"), true);
    assert.equal(agentsGuide.includes("/api/workflow-runs/"), false);

    const guardScriptPath = path.join(workspaceRoot, ".agent-tools", "scripts", "template_bundle_guard.mjs");
    const guardSkillPath = path.join(
      workspaceRoot,
      ".agent-tools",
      "skills",
      "template_bundle_guard",
      "SKILL.md"
    );
    const guardConfigPath = path.join(workspaceRoot, ".agent-tools", "config.json");
    await fs.access(guardScriptPath);
    await fs.access(guardSkillPath);
    await fs.access(guardConfigPath);

    await createSkillSource(workspaceRoot);
    const bundlePath = path.join(workspaceRoot, "bundles", "submitted.bundle.json");

    const invalidBundle = buildBundle("tg_invalid", path.join(workspaceRoot, "workspace"), true);
    await writeJson(bundlePath, invalidBundle);

    const checkFail = await runNode(
      workspaceRoot,
      [".agent-tools/scripts/template_bundle_guard.mjs", "check"],
      { ...process.env, EASYAGENTTEAM_ROOT: repoRoot }
    );
    assert.equal(checkFail.code, 1);
    const checkReportPath = path.join(workspaceRoot, "reports", "template-guard", "last_check.json");
    const checkReport = JSON.parse(await fs.readFile(checkReportPath, "utf8"));
    assert.equal(checkReport.status, "fail");
    assert.equal(Array.isArray(checkReport.hints) && checkReport.hints.length > 0, true);

    const runsBeforePublish = await apiJson(server.baseUrl, "GET", "/api/workflow-runs", undefined, [200]);
    const publishFail = await runNode(
      workspaceRoot,
      [".agent-tools/scripts/template_bundle_guard.mjs", "publish"],
      { ...process.env, EASYAGENTTEAM_ROOT: repoRoot }
    );
    assert.equal(publishFail.code, 1);
    const publishReportPath = path.join(workspaceRoot, "reports", "template-guard", "last_publish.json");
    const publishFailReport = JSON.parse(await fs.readFile(publishReportPath, "utf8"));
    assert.equal(publishFailReport.status, "fail");
    assert.equal(publishFailReport.run_id, null);
    const runsAfterFailedPublish = await apiJson(server.baseUrl, "GET", "/api/workflow-runs", undefined, [200]);
    assert.equal((runsBeforePublish.items ?? []).length, (runsAfterFailedPublish.items ?? []).length);

    const validBundle = buildBundle("tg_valid", path.join(workspaceRoot, "workspace"), false);
    await writeJson(bundlePath, validBundle);

    const publishPass = await runNode(
      workspaceRoot,
      [".agent-tools/scripts/template_bundle_guard.mjs", "publish"],
      { ...process.env, EASYAGENTTEAM_ROOT: repoRoot }
    );
    assert.equal(publishPass.code, 0);
    const publishPassReport = JSON.parse(await fs.readFile(publishReportPath, "utf8"));
    assert.equal(publishPassReport.status, "pass");
    assert.equal(typeof publishPassReport.run_id === "string" && publishPassReport.run_id.length > 0, true);
    assert.equal(typeof publishPassReport.template_id === "string" && publishPassReport.template_id.length > 0, true);
    assert.equal(typeof publishPassReport.project_id === "string" && publishPassReport.project_id.length > 0, true);
  } finally {
    await server.close();
  }
});
