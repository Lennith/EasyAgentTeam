import path from "node:path";
import { ensureDir, writeJsonFile, writeTextFile } from "../src/utils/file-utils.mjs";

function toSlug(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function rolePrompt(roleName, scenario, constraintPack) {
  return [
    `Role Function: ${roleName} responsible for scenario '${scenario.title}'.`,
    "Usable Tools: domain documents, workspace files, and API metadata.",
    "Method: produce reusable outputs with explicit assumptions and traceability.",
    `Goal Context: ${scenario.goal}`,
    "",
    "Constraint pack excerpt:",
    constraintPack
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("- "))
      .slice(0, 6)
      .join("\n")
  ].join("\n");
}

function buildTaskContract(base) {
  return {
    ...base,
    acceptance: [
      `objective: ${base.objective}`,
      `input: ${base.input}`,
      `output: ${base.output}`,
      `constraints: ${base.constraints}`,
      `exception: ${base.exception}`,
      `verification: ${base.verification}`
    ],
    artifacts: base.artifacts,
    write_set: base.writeSet
  };
}

function buildWorkflowTasks(scenario, ids) {
  const minSteps = Math.max(3, Number(scenario.workflow_min_steps || 3));
  const baseTasks = [
    buildTaskContract({
      task_id: `${ids.prefix}_plan`,
      title: "Planning",
      owner_role: ids.lead,
      objective: "define scope and success criteria",
      input: "scenario goal and constraints are documented",
      output: "planning summary and checklist are produced",
      constraints: "implementation work is out of scope in planning",
      exception: "unknown inputs are captured as explicit assumptions",
      verification: "each scope item has owner and acceptance signal",
      artifacts: ["workspace/plan/summary.md", "workspace/plan/checklist.md"],
      writeSet: ["workspace/plan/**"]
    }),
    buildTaskContract({
      task_id: `${ids.prefix}_execute`,
      title: "Execution",
      owner_role: ids.specialist,
      dependencies: [`${ids.prefix}_plan`],
      objective: "deliver execution outputs based on approved plan",
      input: "planning summary and checklist are consumed",
      output: "execution result and trace evidence are written",
      constraints: "scope must remain within approved planning boundary",
      exception: "blockers include impact and fallback action",
      verification: "outputs map to declared acceptance criteria",
      artifacts: ["workspace/exec/result.md", "workspace/exec/evidence.md"],
      writeSet: ["workspace/exec/**"]
    }),
    buildTaskContract({
      task_id: `${ids.prefix}_qa_acceptance`,
      title: "QA Acceptance",
      owner_role: ids.qaGuard,
      dependencies: [`${ids.prefix}_execute`],
      objective: "issue final pass or block decision",
      input: "execution artifacts are reviewed against criteria",
      output: "final acceptance report and checklist status are produced",
      constraints: "QA step is independent from execution role",
      exception: "failed checks include mandatory fix recommendation",
      verification: "each criterion has explicit status and rationale",
      artifacts: ["workspace/qa/checklist.md", "workspace/qa/final.md"],
      writeSet: ["workspace/qa/**"]
    })
  ];

  for (let i = 3; i < minSteps; i += 1) {
    baseTasks.splice(
      baseTasks.length - 1,
      0,
      buildTaskContract({
        task_id: `${ids.prefix}_step_${i + 1}`,
        title: `Extension Step ${i + 1}`,
        owner_role: ids.specialist,
        dependencies: [baseTasks[baseTasks.length - 2].task_id],
        objective: "extend execution result for scenario-specific refinement",
        input: "prior execution step output is consumed",
        output: "extension note and evidence are documented",
        constraints: "no uncontrolled scope expansion",
        exception: "dependency issues are logged with next action",
        verification: "extension output is testable and traceable",
        artifacts: [`workspace/exec/step_${i + 1}.md`],
        writeSet: ["workspace/exec/**"]
      })
    );
    baseTasks[baseTasks.length - 1].dependencies = [baseTasks[baseTasks.length - 2].task_id];
  }
  return baseTasks;
}

function buildProjectTasks(ids) {
  return [
    buildTaskContract({
      task_id: `${ids.prefix}_project_plan`,
      title: "Project Planning",
      owner_role: ids.lead,
      objective: "define project decomposition and ownership",
      input: "project scope baseline and constraints are listed",
      output: "planning summary and milestone map are produced",
      constraints: "implementation details remain in downstream tasks",
      exception: "open assumptions are captured and assigned",
      verification: "plan includes explicit acceptance checkpoints",
      artifacts: ["workspace/project/plan.md"],
      writeSet: ["workspace/project/**"]
    }),
    buildTaskContract({
      task_id: `${ids.prefix}_project_acceptance`,
      title: "Project Acceptance",
      owner_role: ids.qaGuard,
      dependencies: [`${ids.prefix}_project_plan`],
      objective: "provide final project acceptance decision",
      input: "project planning outputs and execution evidence are reviewed",
      output: "acceptance verdict and action items are recorded",
      constraints: "QA role remains independent and evidence-driven",
      exception: "blocked outcomes include fix ownership and next action",
      verification: "each criterion has a pass or fail state",
      artifacts: ["workspace/project/acceptance.md"],
      writeSet: ["workspace/project/**"]
    })
  ];
}

function buildBundle({ scenario, roundIndex, runPrefix, workspaceRoot, constraintPack }) {
  const scenarioSlug = toSlug(scenario.id || `scenario_${roundIndex}`);
  const prefix = `${runPrefix}_${String(roundIndex).padStart(2, "0")}_${scenarioSlug}`.slice(0, 48);
  const projectId = `${prefix}_project`.slice(0, 64);
  const templateId = `${prefix}_wf_tpl`.slice(0, 64);
  const runId = `${prefix}_wf_run`.slice(0, 64);
  const skillListId = `${prefix}_skills`;
  const skillName = `${prefix}-skill`;
  const bundleId = `${prefix}_bundle`;

  const ids = {
    prefix,
    lead: `${prefix}_lead`,
    specialist: `${prefix}_specialist`,
    qaGuard: `${prefix}_qa_guard`
  };

  const scenarioIssue = String(scenario.simulated_issue || "").trim();
  const includeQa = scenarioIssue !== "missing_qa";
  const tasks = scenario.kind === "workflow" ? buildWorkflowTasks(scenario, ids) : buildProjectTasks(ids);

  const agents = [
    {
      agent_id: ids.lead,
      display_name: "Lead",
      prompt: rolePrompt("Lead", scenario, constraintPack),
      skill_list: [skillListId]
    },
    {
      agent_id: ids.specialist,
      display_name: "Specialist",
      prompt: rolePrompt("Specialist", scenario, constraintPack),
      skill_list: [skillListId]
    }
  ];

  if (includeQa) {
    agents.push({
      agent_id: ids.qaGuard,
      display_name: "QA Guard",
      prompt: rolePrompt("QA Guard", scenario, constraintPack),
      skill_list: [skillListId]
    });
  }

  const routeTable = {
    [ids.lead]: includeQa ? [ids.specialist, ids.qaGuard] : [ids.specialist],
    [ids.specialist]: includeQa ? [ids.lead, ids.qaGuard] : [ids.lead]
  };
  if (includeQa) {
    routeTable[ids.qaGuard] = [ids.lead, ids.specialist];
  }

  const taskAssignRouteTable = {
    [ids.lead]: includeQa ? [ids.specialist, ids.qaGuard] : [ids.specialist]
  };
  if (includeQa) {
    taskAssignRouteTable[ids.qaGuard] = [ids.lead];
  }

  return {
    bundle_id: bundleId,
    skills_sources: [`../skills/${scenarioSlug}`],
    skill_lists: [
      {
        list_id: skillListId,
        display_name: `${scenario.title} Skills`,
        include_all: false,
        skill_ids: [skillName]
      }
    ],
    agents,
    project: {
      project_id: projectId,
      name: `${scenario.title} Project`,
      workspace_path: path.join(workspaceRoot, "workspace"),
      agent_ids: agents.map((item) => item.agent_id),
      route_table: routeTable,
      task_assign_route_table: taskAssignRouteTable
    },
    workflow_template: {
      template_id: templateId,
      name: `${scenario.title} Workflow Template`,
      description: scenario.goal,
      tasks
    },
    workflow_run: {
      run_id: runId,
      template_id: templateId,
      name: `${scenario.title} Workflow Run`,
      workspace_path: path.join(workspaceRoot, "workspace"),
      auto_dispatch_enabled: false,
      auto_dispatch_remaining: 0,
      auto_start: false
    }
  };
}

export async function simulateExternalSubagentBundle(input) {
  const scenario = input.scenario;
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const runPrefix = toSlug(input.runPrefix || "cmp");
  const constraintPack = String(input.constraintPack || "").trim();
  const roundIndex = Number(input.roundIndex || 1);

  const scenarioSlug = toSlug(scenario.id || `scenario_${roundIndex}`);
  const skillDir = path.join(workspaceRoot, "skills", scenarioSlug);
  const bundlePath = path.join(workspaceRoot, "bundles", `${scenarioSlug}.bundle.json`);
  await ensureDir(skillDir);
  await ensureDir(path.dirname(bundlePath));
  await ensureDir(path.join(workspaceRoot, "agents"));
  await ensureDir(path.join(workspaceRoot, "roles"));
  await ensureDir(path.join(workspaceRoot, "workspace"));

  const bundle = buildBundle({ scenario, roundIndex, runPrefix, workspaceRoot, constraintPack });
  const skillName = bundle.skill_lists?.[0]?.skill_ids?.[0] || `${scenarioSlug}-skill`;
  const skillContent = `---
name: ${skillName}
description: generated by campaign simulated external subagent
license: MIT
compatibility: local
---

# ${skillName}

Domain: ${scenario.domain}
Goal: ${scenario.goal}
`;
  await writeTextFile(path.join(skillDir, "SKILL.md"), skillContent);
  await writeTextFile(path.join(workspaceRoot, "roles", `${scenarioSlug}.md`), `# ${scenario.title}\n\n${scenario.goal}\n`);
  await writeTextFile(path.join(workspaceRoot, "agents", `${scenarioSlug}.md`), `# Agent Plan\n\nGenerated by simulated subagent.\n`);
  await writeJsonFile(bundlePath, bundle);

  return {
    bundlePath,
    bundle,
    skillDir,
    mode: "simulated_external_subagent"
  };
}
