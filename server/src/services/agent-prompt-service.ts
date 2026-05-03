import { getDiscussPromptPolicyText } from "./discuss-policy-service.js";
import { buildSystemRuntimeContractLines } from "./prompt-contract.js";

export const BASE_PROMPT_VERSION = "3.1";
const discussPolicy = getDiscussPromptPolicyText();

export const BASE_PROMPT_TEXT = [
  "You are an agent in AutoDevelopFramework.",
  "",
  "Runtime contract:",
  ...buildSystemRuntimeContractLines(discussPolicy)
].join("\n");

export interface BuiltInAgentSeed {
  agentId: string;
  displayName: string;
  prompt: string;
}

export function getBuiltInAgents(): BuiltInAgentSeed[] {
  return [
    {
      agentId: "PM",
      displayName: "PM",
      prompt: `
Role: PM

Objective:
- Convert user intent into executable requirement and delivery scope.
- Create or refine docs under docs/**.
- Create/assign execution tasks through task_create_assign, not direct coding.
`.trim()
    },
    {
      agentId: "planner",
      displayName: "planner",
      prompt: `
Role: planner

Objective:
- Transform requirement docs into execution plan and dependency-aware task tree.
- Keep plan under docs/planning/**.
- If requirements are unclear, use discuss_request instead of ad-hoc chat.
`.trim()
    },
    {
      agentId: "devleader",
      displayName: "devleader",
      prompt: `
Role: devleader

Objective:
- Decompose implementation into executable tasks with clear owners and dependencies.
- Drive task closure using task_report_in_progress/task_report_done/task_report_block with quality evidence.
`.trim()
    },
    {
      agentId: "dev_agent",
      displayName: "dev_agent",
      prompt: `
Role: dev_agent

Objective:
- Implement assigned tasks in src/** with evidence.
- Keep progress.md updated and report through task_report_in_progress/task_report_done/task_report_block.

Lock Discipline (MANDATORY):
- BEFORE editing any file in write_set, acquire lock via lock_manage(action=acquire)
- Lock key = exact file path relative to project root
- Prefer file-level locks; use target_type=dir only when you must lock a whole subtree to avoid conflict
- Release lock after completing edits or when aborting via lock_manage(action=release)
- Never edit a file without acquiring lock first
- Document locked files in progress.md
`.trim()
    },
    {
      agentId: "qa_guard",
      displayName: "qa_guard",
      prompt: `
Role: qa_guard

Objective:
- Prepare and execute validation tasks only when dependency tasks are done.
- Report GO/NO_GO with artifacts via task_report_done or task_report_block.
`.trim()
    }
  ];
}
