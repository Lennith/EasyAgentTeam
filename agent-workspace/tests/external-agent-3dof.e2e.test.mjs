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

async function writeJson(absolutePath, payload) {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function createSkillSource(workspaceRoot) {
  const skillDir = path.join(workspaceRoot, "skills", "sensor_pipeline");
  await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
  const content = `---
name: ext_3dof_sensor_pipeline_skill
description: 3DoF sensor calibration workflow capability
license: MIT
compatibility: local
---

# ext_3dof_sensor_pipeline_skill

Support Android and PC calibration collaboration.
`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
  await fs.writeFile(path.join(skillDir, "assets", "readme.txt"), "skill asset", "utf8");
}

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

function build3DoFBundle(seed) {
  return {
    bundle_id: seed.bundleId,
    skills_sources: ["../skills/sensor_pipeline"],
    skill_lists: [
      {
        list_id: `${seed.prefix}_skills`,
        display_name: "3DoF Calibration Skills",
        include_all: false,
        skill_ids: ["ext_3dof_sensor_pipeline_skill"]
      }
    ],
    agents: [
      {
        agent_id: `${seed.prefix}_architect`,
        display_name: "System Architect",
        prompt:
          "Role Function: design Android-PC calibration architecture and delivery plan. Usable Tools: architecture docs, protocol references, and requirement notes. Method: staged decomposition with explicit trade-offs.",
        skill_list: [`${seed.prefix}_skills`]
      },
      {
        agent_id: `${seed.prefix}_android_dev`,
        display_name: "Android Developer",
        prompt:
          "Role Function: implement Android-side data collection APK. Usable Tools: Android build tools, instrumentation scripts, and API specs. Method: incremental implementation with evidence checkpoints.",
        skill_list: [`${seed.prefix}_skills`]
      },
      {
        agent_id: `${seed.prefix}_pc_dev`,
        display_name: "PC Tool Developer",
        prompt:
          "Role Function: implement PC calibration and validation tooling. Usable Tools: desktop runtime, calibration scripts, and protocol analyzers. Method: test-driven implementation with traceable outputs.",
        skill_list: [`${seed.prefix}_skills`]
      },
      {
        agent_id: `${seed.prefix}_integration_dev`,
        display_name: "Integration Developer",
        prompt:
          "Role Function: integrate Android and PC workflows over WiFi communication. Usable Tools: integration tests, network diagnostics, and protocol logs. Method: dependency-first integration with rollback notes.",
        skill_list: [`${seed.prefix}_skills`]
      },
      {
        agent_id: `${seed.prefix}_qa_guard`,
        display_name: "QA Guard",
        prompt:
          "Role Function: own acceptance, verification, and release checklist closure. Usable Tools: QA checklists, validation suites, and defect tracker notes. Method: criteria-first acceptance with explicit pass or block outcome.",
        skill_list: [`${seed.prefix}_skills`]
      }
    ],
    project: {
      project_id: `${seed.prefix}_project`,
      name: "3DoF Sensor Temperature Calibration",
      workspace_path: seed.workspacePath,
      agent_ids: [
        `${seed.prefix}_architect`,
        `${seed.prefix}_android_dev`,
        `${seed.prefix}_pc_dev`,
        `${seed.prefix}_integration_dev`,
        `${seed.prefix}_qa_guard`
      ],
      route_table: {
        [`${seed.prefix}_architect`]: [
          `${seed.prefix}_android_dev`,
          `${seed.prefix}_pc_dev`,
          `${seed.prefix}_integration_dev`,
          `${seed.prefix}_qa_guard`
        ],
        [`${seed.prefix}_android_dev`]: [`${seed.prefix}_integration_dev`, `${seed.prefix}_qa_guard`],
        [`${seed.prefix}_pc_dev`]: [`${seed.prefix}_integration_dev`, `${seed.prefix}_qa_guard`],
        [`${seed.prefix}_integration_dev`]: [`${seed.prefix}_architect`, `${seed.prefix}_qa_guard`],
        [`${seed.prefix}_qa_guard`]: [`${seed.prefix}_architect`, `${seed.prefix}_integration_dev`]
      },
      task_assign_route_table: {
        [`${seed.prefix}_architect`]: [
          `${seed.prefix}_android_dev`,
          `${seed.prefix}_pc_dev`,
          `${seed.prefix}_integration_dev`,
          `${seed.prefix}_qa_guard`
        ],
        [`${seed.prefix}_qa_guard`]: [`${seed.prefix}_integration_dev`, `${seed.prefix}_architect`]
      }
    },
    workflow_template: {
      template_id: `${seed.prefix}_wf_tpl`,
      name: "3DoF Calibration Delivery Workflow",
      tasks: [
        {
          task_id: "phase_architecture",
          title: "Architecture and API contract",
          owner_role: `${seed.prefix}_architect`,
          acceptance: [
            "objective: define architecture and API contract",
            "input: use case goals and constraints are listed",
            "output: architecture spec and interface contract are produced",
            "constraints: implementation details stay in downstream tasks",
            "exception: unresolved assumptions are documented",
            "verification: each module boundary has acceptance criteria"
          ],
          artifacts: ["workspace/architecture/spec.md", "workspace/architecture/api_contract.md"],
          write_set: ["workspace/architecture/**"]
        },
        {
          task_id: "phase_android_data_collector",
          title: "Android APK data collector implementation",
          owner_role: `${seed.prefix}_android_dev`,
          dependencies: ["phase_architecture"],
          acceptance: [
            "objective: implement Android data collection pipeline",
            "input: approved architecture and API contract are consumed",
            "output: apk module notes and data capture evidence are generated",
            "constraints: do not alter cross-device protocol without agreement",
            "exception: blockers include fallback and impact",
            "verification: collected data format matches contract"
          ],
          artifacts: ["workspace/android/collector.md", "workspace/android/evidence.md"],
          write_set: ["workspace/android/**"]
        },
        {
          task_id: "phase_pc_calibration_tool",
          title: "PC calibration and validation tool implementation",
          owner_role: `${seed.prefix}_pc_dev`,
          dependencies: ["phase_architecture"],
          acceptance: [
            "objective: implement PC calibration and validation tool",
            "input: approved architecture and API contract are consumed",
            "output: calibration flow and validation evidence are produced",
            "constraints: maintain protocol compatibility with Android side",
            "exception: mismatch issues include remediation path",
            "verification: calibration result format is testable"
          ],
          artifacts: ["workspace/pc/calibration.md", "workspace/pc/evidence.md"],
          write_set: ["workspace/pc/**"]
        },
        {
          task_id: "phase_wifi_integration",
          title: "Android-PC WiFi integration and protocol check",
          owner_role: `${seed.prefix}_integration_dev`,
          dependencies: ["phase_android_data_collector", "phase_pc_calibration_tool"],
          acceptance: [
            "objective: complete end-to-end WiFi integration",
            "input: Android and PC implementation outputs are available",
            "output: integration walkthrough and protocol validation notes",
            "constraints: retain deterministic data flow and error handling",
            "exception: communication failures include retry strategy",
            "verification: both endpoints exchange data successfully"
          ],
          artifacts: ["workspace/integration/wifi.md", "workspace/integration/protocol_check.md"],
          write_set: ["workspace/integration/**"]
        },
        {
          task_id: "phase_release_acceptance",
          title: "QA acceptance and release gate review",
          owner_role: `${seed.prefix}_qa_guard`,
          dependencies: ["phase_wifi_integration"],
          acceptance: [
            "objective: issue final release gate decision",
            "input: architecture, implementation, and integration artifacts are reviewed",
            "output: QA acceptance verdict and release notes are produced",
            "constraints: acceptance remains independent and evidence-driven",
            "exception: failed criteria include fix ownership and next action",
            "verification: each gate criterion has explicit status and rationale"
          ],
          artifacts: ["workspace/qa/final_gate.md", "workspace/qa/release_notes.md"],
          write_set: ["workspace/qa/**"]
        }
      ]
    },
    workflow_run: {
      run_id: `${seed.prefix}_wf_run`,
      template_id: `${seed.prefix}_wf_tpl`,
      name: "3DoF Calibration Workflow Run",
      workspace_path: seed.workspacePath,
      auto_dispatch_enabled: false,
      auto_dispatch_remaining: 0,
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

async function waitForFinished(baseUrl, runId, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusPayload = await apiJson(baseUrl, "GET", `/api/workflow-runs/${runId}/status`, undefined, [200]);
    if (statusPayload.status === "finished") {
      return statusPayload;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return apiJson(baseUrl, "GET", `/api/workflow-runs/${runId}/status`, undefined, [200]);
}

test("external-agent 3dof e2e: simulated subagent generates bundle, registers full chain, and converges", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-external-3dof-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "external-agent-workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);

  try {
    const initResult = await initAgentWorkspace({
      goal: "Generate and register a 3DoF sensor calibration workflow with Android + PC over WiFi",
      baseUrl: server.baseUrl,
      workspaceRoot
    });
    assert.equal(initResult.status, "pass");

    await createSkillSource(workspaceRoot);
    const bundle = build3DoFBundle({
      bundleId: "external_3dof_bundle",
      prefix: "ext3dof",
      workspacePath: path.join(workspaceRoot, "workspace")
    });
    const bundlePath = path.join(workspaceRoot, "bundles", "submitted.bundle.json");
    await writeJson(bundlePath, bundle);

    const checkResult = await runNode(
      workspaceRoot,
      [".agent-tools/scripts/template_bundle_guard.mjs", "check"],
      { ...process.env, EASYAGENTTEAM_ROOT: repoRoot }
    );
    assert.equal(checkResult.code, 0);
    const publishResult = await runNode(
      workspaceRoot,
      [".agent-tools/scripts/template_bundle_guard.mjs", "publish"],
      { ...process.env, EASYAGENTTEAM_ROOT: repoRoot }
    );
    assert.equal(publishResult.code, 0);
    const publishReportPath = path.join(workspaceRoot, "reports", "template-guard", "last_publish.json");
    const publishReport = JSON.parse(await fs.readFile(publishReportPath, "utf8"));
    assert.equal(publishReport.status, "pass");
    assert.equal(publishReport.project_id, "ext3dof_project");
    assert.equal(publishReport.template_id, "ext3dof_wf_tpl");
    assert.equal(publishReport.run_id, "ext3dof_wf_run");

    await apiJson(server.baseUrl, "POST", "/api/workflow-runs/ext3dof_wf_run/start", {}, [200]);

    const sessionRoles = [
      "ext3dof_architect",
      "ext3dof_android_dev",
      "ext3dof_pc_dev",
      "ext3dof_integration_dev",
      "ext3dof_qa_guard"
    ];
    for (const role of sessionRoles) {
      await apiJson(
        server.baseUrl,
        "POST",
        "/api/workflow-runs/ext3dof_wf_run/sessions",
        { role, session_id: `session-${role}` },
        [200, 201]
      );
    }

    const taskReports = [
      { role: "ext3dof_architect", taskId: "phase_architecture" },
      { role: "ext3dof_android_dev", taskId: "phase_android_data_collector" },
      { role: "ext3dof_pc_dev", taskId: "phase_pc_calibration_tool" },
      { role: "ext3dof_integration_dev", taskId: "phase_wifi_integration" },
      { role: "ext3dof_qa_guard", taskId: "phase_release_acceptance" }
    ];

    for (const item of taskReports) {
      await apiJson(
        server.baseUrl,
        "POST",
        "/api/workflow-runs/ext3dof_wf_run/task-actions",
        {
          action_type: "TASK_REPORT",
          from_agent: item.role,
          from_session_id: `session-${item.role}`,
          results: [
            {
              task_id: item.taskId,
              outcome: "DONE",
              summary: `${item.taskId} complete`
            }
          ]
        },
        [200]
      );
    }

    const finalStatus = await waitForFinished(server.baseUrl, "ext3dof_wf_run");
    assert.equal(["running", "finished"].includes(String(finalStatus.status)), true);

    const runtime = await apiJson(server.baseUrl, "GET", "/api/workflow-runs/ext3dof_wf_run/task-runtime", undefined, [
      200
    ]);
    const taskStates = (runtime.tasks ?? []).map((task) => String(task.state || ""));
    assert.equal(taskStates.some((state) => state === "DONE"), true);
    assert.equal(taskStates.some((state) => state === "BLOCKED" || state === "FAILED"), false);
  } finally {
    await server.close();
  }
});
