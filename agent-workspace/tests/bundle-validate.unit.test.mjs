import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { validateBundleModule } from "../src/modules/skill.bundle.validate.mjs";
import { AgentWorkspaceError } from "../src/errors.mjs";

async function createSkill(bundleDir, relativeDir, name) {
  const dir = path.join(bundleDir, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\nlicense: MIT\ncompatibility: local\n---\n\n# ${name}\n`,
    "utf8"
  );
}

function buildMockContext(bundleDir, bundle) {
  return {
    bundleId: bundle.bundle_id,
    bundleDir,
    bundle,
    existing: {
      skills: new Set(),
      skillLists: new Set(),
      agents: new Set(),
      projects: new Set(),
      workflowTemplates: new Set(),
      workflowRuns: new Set()
    },
    computed: {},
    execution: { created: {}, rollback: [], steps: [] }
  };
}

test("bundle validation passes for valid full-chain payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-validate-pass-"));
  const bundleDir = path.join(root, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  await createSkill(bundleDir, "skills/skill_a", "tg-skill-a");

  const bundle = {
    bundle_id: "bundle_ok",
    skills_sources: ["./skills/skill_a"],
    skill_lists: [{ list_id: "tg_list", skill_ids: ["tg-skill-a"] }],
    agents: [
      {
        agent_id: "tg_mgr",
        prompt:
          "Role Function: define workflow planning and ownership.\nUsable Tools: docs and planning board.\nMethod: milestone planning with explicit assumptions.",
        skill_list: ["tg_list"]
      },
      {
        agent_id: "tg_dev",
        prompt:
          "Role Function: execute implementation tasks.\nUsable Tools: source workspace and API client.\nMethod: incremental implementation with evidence.",
        skill_list: ["tg_list"]
      },
      {
        agent_id: "tg_qa_guard",
        prompt:
          "Role Function: own acceptance decision.\nUsable Tools: checklist and test report.\nMethod: criteria-first verification.",
        skill_list: ["tg_list"]
      }
    ],
    project: {
      project_id: "tg_project",
      name: "TG Project",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      agent_ids: ["tg_mgr", "tg_dev", "tg_qa_guard"],
      route_table: {
        tg_mgr: ["tg_dev", "tg_qa_guard"],
        tg_qa_guard: ["tg_mgr"]
      },
      task_assign_route_table: {
        tg_mgr: ["tg_dev", "tg_qa_guard"]
      }
    },
    workflow_template: {
      template_id: "tg_tpl",
      name: "TG TPL",
      tasks: [
        {
          task_id: "a",
          title: "A",
          owner_role: "tg_mgr",
          acceptance: [
            "objective: define scope and owner mapping",
            "input: requirement and constraints are listed",
            "output: planning summary and checklist are produced",
            "constraints: do not perform implementation work",
            "exception: unknown inputs are logged as assumptions",
            "verification: each scope item has acceptance condition"
          ],
          artifacts: ["workspace/plan/summary.md", "workspace/plan/checklist.md"],
          write_set: ["workspace/plan/**"]
        },
        {
          task_id: "b",
          title: "B",
          owner_role: "tg_dev",
          dependencies: ["a"],
          acceptance: [
            "objective: produce implementation output",
            "input: approved planning summary is consumed",
            "output: implementation notes and evidence are created",
            "constraints: remain inside approved scope",
            "exception: blockers include fallback action",
            "verification: output maps to planned acceptance criteria"
          ],
          artifacts: ["workspace/exec/result.md", "workspace/exec/evidence.md"],
          write_set: ["workspace/exec/**"]
        },
        {
          task_id: "c",
          title: "C",
          owner_role: "tg_qa_guard",
          dependencies: ["b"],
          acceptance: [
            "objective: issue final gate decision",
            "input: implementation artifacts are reviewed",
            "output: pass or block decision is documented",
            "constraints: keep QA independent from implementation role",
            "exception: failed checks include minimum fix guidance",
            "verification: each criterion has status and reason"
          ],
          artifacts: ["workspace/qa/checklist.md", "workspace/qa/final.md"],
          write_set: ["workspace/qa/**"]
        }
      ]
    },
    workflow_run: {
      run_id: "tg_run",
      template_id: "tg_tpl",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      auto_start: false
    }
  };

  const context = buildMockContext(bundleDir, bundle);
  await validateBundleModule(context);
  assert.equal(context.computed.predictedSkillIds.includes("tg-skill-a"), true);
});

test("bundle validation rejects conflict and invalid references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-validate-fail-"));
  const bundleDir = path.join(root, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  await createSkill(bundleDir, "skills/skill_a", "tg-skill-a");

  const bundle = {
    bundle_id: "bundle_fail",
    skills_sources: ["./skills/skill_a"],
    skill_lists: [{ list_id: "tg_list", skill_ids: ["missing-skill"] }],
    agents: [{ agent_id: "bad id", prompt: "x", skill_list: ["tg_list"] }],
    project: {
      project_id: "bad project id",
      name: "Bad",
      workspace_path: "D:\\tmp",
      agent_ids: ["unknown_agent"]
    },
    workflow_template: {
      template_id: "tpl_ok",
      name: "tpl",
      tasks: [{ task_id: "a", title: "A", owner_role: "unknown_agent" }]
    },
    workflow_run: {
      run_id: "run_ok",
      template_id: "tpl_mismatch",
      workspace_path: "D:\\tmp",
      auto_start: true
    }
  };

  const context = buildMockContext(bundleDir, bundle);
  context.existing.projects.add("bad_project");
  let caught = null;
  try {
    await validateBundleModule(context);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AgentWorkspaceError);
  assert.equal(caught.code, "BUNDLE_VALIDATION_FAILED");
  assert.equal(Array.isArray(caught.details?.errors), true);
  assert.equal(caught.details.errors.length > 0, true);
});

test("bundle validation rejects project bundle without qa guard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-validate-qa-fail-"));
  const bundleDir = path.join(root, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  await createSkill(bundleDir, "skills/skill_a", "tg-skill-a");

  const bundle = {
    bundle_id: "bundle_qa_fail",
    skills_sources: ["./skills/skill_a"],
    skill_lists: [{ list_id: "tg_list", skill_ids: ["tg-skill-a"] }],
    agents: [
      {
        agent_id: "tg_mgr",
        prompt:
          "Role Function: planning ownership.\nUsable Tools: requirement docs and planning board.\nMethod: structured decomposition.",
        skill_list: ["tg_list"]
      },
      {
        agent_id: "tg_dev",
        prompt:
          "Role Function: implementation execution.\nUsable Tools: source workspace and test tools.\nMethod: iterative build and evidence.",
        skill_list: ["tg_list"]
      }
    ],
    project: {
      project_id: "tg_project",
      name: "TG Project",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      agent_ids: ["tg_mgr", "tg_dev"],
      route_table: {
        tg_mgr: ["tg_dev"],
        tg_dev: ["tg_mgr"]
      }
    },
    workflow_template: {
      template_id: "tg_tpl",
      name: "TG TPL",
      tasks: [
        {
          task_id: "a",
          title: "A",
          owner_role: "tg_mgr",
          acceptance: [
            "objective: define planning output",
            "input: baseline requirement exists",
            "output: planning summary is created",
            "constraints: no implementation output here",
            "exception: assumptions are documented",
            "verification: acceptance criteria are explicit"
          ],
          artifacts: ["workspace/plan/summary.md"],
          write_set: ["workspace/plan/**"]
        }
      ]
    },
    workflow_run: {
      run_id: "tg_run",
      template_id: "tg_tpl",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      auto_start: false
    }
  };

  const context = buildMockContext(bundleDir, bundle);
  let caught = null;
  try {
    await validateBundleModule(context);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AgentWorkspaceError);
  assert.equal(caught.code, "BUNDLE_VALIDATION_FAILED");
  assert.equal(
    (caught.details?.errors ?? []).some((item) => String(item).includes("QA Guard")),
    true
  );
});

test("bundle validation rejects prompts that include framework runtime internals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-validate-prompt-warn-"));
  const bundleDir = path.join(root, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  await createSkill(bundleDir, "skills/skill_a", "tg-skill-a");

  const bundle = {
    bundle_id: "bundle_prompt_warn",
    skills_sources: ["./skills/skill_a"],
    skill_lists: [{ list_id: "tg_list", skill_ids: ["tg-skill-a"] }],
    agents: [
      {
        agent_id: "tg_mgr",
        prompt:
          "Role: Manager. Use EasyAgentTeam workspace contract and manager-routed ToolCall protocol with route_table."
      },
      {
        agent_id: "tg_dev",
        prompt: "Role: Developer. Function: implementation. Tools: HTTP API and IDE. Method: incremental delivery."
      },
      {
        agent_id: "tg_qa_guard",
        prompt: "Role: QA. Function: acceptance. Tools: test runner. Method: evidence-based checks."
      }
    ],
    project: {
      project_id: "tg_project",
      name: "TG Project",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      agent_ids: ["tg_mgr", "tg_dev", "tg_qa_guard"],
      route_table: {
        tg_mgr: ["tg_dev", "tg_qa_guard"]
      }
    },
    workflow_template: {
      template_id: "tg_tpl",
      name: "TG TPL",
      tasks: [
        { task_id: "a", title: "A", owner_role: "tg_mgr" },
        { task_id: "b", title: "B", owner_role: "tg_dev", dependencies: ["a"] },
        { task_id: "c", title: "C", owner_role: "tg_qa_guard", dependencies: ["b"] }
      ]
    },
    workflow_run: {
      run_id: "tg_run",
      template_id: "tg_tpl",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      auto_start: false
    }
  };

  const context = buildMockContext(bundleDir, bundle);
  let caught = null;
  try {
    await validateBundleModule(context);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AgentWorkspaceError);
  assert.equal(caught.code, "BUNDLE_VALIDATION_FAILED");
  assert.equal(
    (caught.details?.errors ?? []).some((item) => String(item).includes("forbidden framework runtime terms")),
    true
  );
});

test("bundle validation rejects workflow tasks when business contract fields are incomplete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-validate-task-warn-"));
  const bundleDir = path.join(root, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  await createSkill(bundleDir, "skills/skill_a", "tg-skill-a");

  const bundle = {
    bundle_id: "bundle_task_warn",
    skills_sources: ["./skills/skill_a"],
    skill_lists: [{ list_id: "tg_list", skill_ids: ["tg-skill-a"] }],
    agents: [
      {
        agent_id: "tg_mgr",
        prompt: "Role: Manager. Function: planning. Tools: docs and API. Method: structured handoff."
      },
      {
        agent_id: "tg_dev",
        prompt: "Role: Developer. Function: build. Tools: source code and scripts. Method: iterative delivery."
      },
      {
        agent_id: "tg_qa_guard",
        prompt: "Role: QA. Function: validate. Tools: test runner. Method: checklist-based verification."
      }
    ],
    project: {
      project_id: "tg_project",
      name: "TG Project",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      agent_ids: ["tg_mgr", "tg_dev", "tg_qa_guard"],
      route_table: {
        tg_mgr: ["tg_dev", "tg_qa_guard"]
      }
    },
    workflow_template: {
      template_id: "tg_tpl",
      name: "TG TPL",
      tasks: [
        { task_id: "a", title: "Plan", owner_role: "tg_mgr" },
        { task_id: "b", title: "Execute", owner_role: "tg_dev", dependencies: ["a"] },
        { task_id: "c", title: "Acceptance", owner_role: "tg_qa_guard", dependencies: ["b"] }
      ]
    },
    workflow_run: {
      run_id: "tg_run",
      template_id: "tg_tpl",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      auto_start: false
    }
  };

  const context = buildMockContext(bundleDir, bundle);
  let caught = null;
  try {
    await validateBundleModule(context);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AgentWorkspaceError);
  assert.equal(caught.code, "BUNDLE_VALIDATION_FAILED");
  assert.equal(
    (caught.details?.errors ?? []).some((item) => String(item).includes("missing required business contract fields")),
    true
  );
});

test("bundle validation rejects template execution-control traces in prompts/tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-validate-exec-trace-fail-"));
  const bundleDir = path.join(root, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  await createSkill(bundleDir, "skills/skill_a", "tg-skill-a");

  const bundle = {
    bundle_id: "bundle_exec_trace_fail",
    skills_sources: ["./skills/skill_a"],
    skill_lists: [{ list_id: "tg_list", skill_ids: ["tg-skill-a"] }],
    agents: [
      {
        agent_id: "tg_mgr",
        prompt:
          "Role Function: planning.\nUsable Tools: docs and APIs.\nMethod: structured handoff.\nAfter work call /api/workflow-runs/demo/start and TASK_REPORT."
      },
      {
        agent_id: "tg_dev",
        prompt:
          "Role Function: implementation.\nUsable Tools: workspace and test runner.\nMethod: iterative delivery."
      },
      {
        agent_id: "tg_qa_guard",
        prompt:
          "Role Function: acceptance.\nUsable Tools: checklist and evidence docs.\nMethod: criteria-first review."
      }
    ],
    project: {
      project_id: "tg_project",
      name: "TG Project",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      agent_ids: ["tg_mgr", "tg_dev", "tg_qa_guard"],
      route_table: {
        tg_mgr: ["tg_dev", "tg_qa_guard"]
      }
    },
    workflow_template: {
      template_id: "tg_tpl",
      name: "TG TPL",
      tasks: [
        {
          task_id: "a",
          title: "Plan",
          owner_role: "tg_mgr",
          acceptance: [
            "objective: define scope",
            "input: requirement baseline",
            "output: planning summary",
            "constraints: avoid direct runtime control",
            "exception: assumptions are documented",
            "verification: acceptance checklist is complete",
            "note: use task_report_done after this step"
          ],
          artifacts: ["workspace/plan/summary.md"],
          write_set: ["workspace/plan/**"]
        },
        {
          task_id: "b",
          title: "Execute",
          owner_role: "tg_dev",
          dependencies: ["a"],
          acceptance: [
            "objective: produce implementation",
            "input: planning summary",
            "output: execution artifact",
            "constraints: remain in approved scope",
            "exception: blockers include fallback",
            "verification: deliverables pass checks"
          ],
          artifacts: ["workspace/exec/result.md"],
          write_set: ["workspace/exec/**"]
        },
        {
          task_id: "c",
          title: "QA",
          owner_role: "tg_qa_guard",
          dependencies: ["b"],
          acceptance: [
            "objective: issue final gate",
            "input: implementation artifacts",
            "output: pass or block report",
            "constraints: independent QA review",
            "exception: failed checks include fix guidance",
            "verification: all criteria include rationale"
          ],
          artifacts: ["workspace/qa/final.md"],
          write_set: ["workspace/qa/**"]
        }
      ]
    },
    workflow_run: {
      run_id: "tg_run",
      template_id: "tg_tpl",
      workspace_path: "D:\\AgentWorkSpace\\TG\\Project",
      auto_start: false
    }
  };

  const context = buildMockContext(bundleDir, bundle);
  let caught = null;
  try {
    await validateBundleModule(context);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AgentWorkspaceError);
  assert.equal(caught.code, "BUNDLE_VALIDATION_FAILED");
  assert.equal(
    (caught.details?.errors ?? []).some((item) => String(item).includes("forbidden execution-control instructions")),
    true
  );
});

