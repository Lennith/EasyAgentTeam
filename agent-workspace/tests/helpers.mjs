import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { loadTemplateBundle } from "../src/bundle-loader.mjs";
import { createRuntimeContext } from "../src/context.mjs";

export async function createTempBundle(bundleObject) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-test-"));
  const bundleDir = path.join(root, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, "bundle.json");
  await fs.writeFile(bundlePath, `${JSON.stringify(bundleObject, null, 2)}\n`, "utf8");
  return { root, bundleDir, bundlePath };
}

export async function createSkillSource(bundleDir, relativeDir, skillName) {
  const skillDir = path.join(bundleDir, relativeDir);
  await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
  const content = `---
name: ${skillName}
description: test skill
license: MIT
compatibility: local
---

# ${skillName}

test skill
`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
  await fs.writeFile(path.join(skillDir, "assets", "note.txt"), "asset", "utf8");
}

export function buildBundle(seed) {
  return {
    bundle_id: seed.bundleId,
    skills_sources: ["./skills/skill_a"],
    skill_lists: [
      {
        list_id: `${seed.prefix}_skill_list`,
        display_name: "Skill List",
        include_all: false,
        skill_ids: [`${seed.prefix}-skill-a`]
      }
    ],
    agents: [
      {
        agent_id: `${seed.prefix}_mgr`,
        display_name: "Manager",
        prompt:
          "Role Function: define plan and ownership for workflow delivery.\nUsable Tools: requirement docs, planning board, API references.\nMethod: milestone-driven planning with explicit assumptions and handoff criteria.",
        skill_list: [`${seed.prefix}_skill_list`]
      },
      {
        agent_id: `${seed.prefix}_dev`,
        display_name: "Developer",
        prompt:
          "Role Function: execute implementation tasks and produce deliverables.\nUsable Tools: workspace source files, test runner, API client.\nMethod: incremental execution with evidence-backed updates.",
        skill_list: [`${seed.prefix}_skill_list`]
      },
      {
        agent_id: `${seed.prefix}_qa_guard`,
        display_name: "QA Guard",
        prompt:
          "Role Function: own quality acceptance and release gate decisions.\nUsable Tools: verification checklist, audit logs, test reports.\nMethod: criteria-first validation and explicit pass/block conclusions.",
        skill_list: [`${seed.prefix}_skill_list`]
      }
    ],
    project: {
      project_id: `${seed.prefix}_project`,
      name: `${seed.prefix} Project`,
      workspace_path: seed.workspacePath,
      agent_ids: [`${seed.prefix}_mgr`, `${seed.prefix}_dev`, `${seed.prefix}_qa_guard`],
      route_table: {
        [`${seed.prefix}_mgr`]: [`${seed.prefix}_dev`, `${seed.prefix}_qa_guard`],
        [`${seed.prefix}_dev`]: [`${seed.prefix}_mgr`, `${seed.prefix}_qa_guard`],
        [`${seed.prefix}_qa_guard`]: [`${seed.prefix}_mgr`, `${seed.prefix}_dev`]
      },
      task_assign_route_table: {
        [`${seed.prefix}_mgr`]: [`${seed.prefix}_dev`, `${seed.prefix}_qa_guard`],
        [`${seed.prefix}_qa_guard`]: [`${seed.prefix}_dev`]
      }
    },
    workflow_template: {
      template_id: `${seed.prefix}_wf_tpl`,
      name: `${seed.prefix} workflow template`,
      tasks: [
        {
          task_id: `${seed.prefix}_wf_task_a`,
          title: "Task A",
          owner_role: `${seed.prefix}_mgr`,
          acceptance: [
            "objective: lock implementation scope and delivery target",
            "input: requirement context and baseline constraints are listed",
            "output: planning summary and execution checklist are created",
            "constraints: no implementation output is produced in planning stage",
            "exception: missing inputs are captured as explicit assumptions",
            "verification: each scope item has owner and acceptance criteria"
          ],
          artifacts: ["workspace/plan/summary.md", "workspace/plan/checklist.md"],
          write_set: ["workspace/plan/**"]
        },
        {
          task_id: `${seed.prefix}_wf_task_b`,
          title: "Task B",
          owner_role: `${seed.prefix}_dev`,
          parent_task_id: `${seed.prefix}_wf_task_a`,
          dependencies: [`${seed.prefix}_wf_task_a`],
          acceptance: [
            "objective: complete implementation outputs defined by planning task",
            "input: approved planning summary and checklist are consumed",
            "output: implementation result and trace evidence are generated",
            "constraints: stay within approved scope and do not bypass QA",
            "exception: blockers include cause, impact, and fallback action",
            "verification: all deliverables map to acceptance criteria"
          ],
          artifacts: ["workspace/exec/result.md", "workspace/exec/evidence.md"],
          write_set: ["workspace/exec/**"]
        },
        {
          task_id: `${seed.prefix}_wf_task_c`,
          title: "Task C",
          owner_role: `${seed.prefix}_qa_guard`,
          dependencies: [`${seed.prefix}_wf_task_b`],
          acceptance: [
            "objective: deliver explicit pass or block gate decision",
            "input: implementation artifacts and evidence are reviewed",
            "output: acceptance report with final conclusion is produced",
            "constraints: acceptance remains independent from execution role",
            "exception: failed checks include mandatory fix recommendation",
            "verification: every check item has status and rationale"
          ],
          artifacts: ["workspace/qa/checklist.md", "workspace/qa/final.md"],
          write_set: ["workspace/qa/**"]
        }
      ]
    },
    workflow_run: {
      run_id: `${seed.prefix}_wf_run`,
      template_id: `${seed.prefix}_wf_tpl`,
      name: `${seed.prefix} workflow run`,
      workspace_path: seed.workspacePath,
      auto_dispatch_enabled: false,
      auto_dispatch_remaining: 0,
      auto_start: false
    }
  };
}

export async function createContextFromBundle(baseUrl, bundlePath, dryRun = false) {
  const loaded = await loadTemplateBundle(bundlePath);
  return createRuntimeContext({
    bundleId: loaded.bundleId,
    bundlePath: loaded.bundlePath,
    bundleDir: loaded.bundleDir,
    bundle: loaded.bundle,
    baseUrl,
    dryRun
  });
}

