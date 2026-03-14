import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectRecord } from "../domain/models.js";
import { ensureDirectory } from "../data/file-utils.js";
import type { HostPlatform } from "../runtime-platform.js";
import { getRuntimePlatformCapabilities } from "../runtime-platform.js";

const AGENTS_DIR = "Agents";
const WORKSPACE_TEMPLATE_DIR = path.join("TeamTools", "templates", "agent-workspace");
const TEAM_TEMPLATE_FILE = path.join(WORKSPACE_TEMPLATE_DIR, "TEAM.md");
const AGENT_GUIDE_TEMPLATE_FILE = path.join(WORKSPACE_TEMPLATE_DIR, "agent.AGENTS.md");
const ROLE_TEMPLATE_FILE = path.join(WORKSPACE_TEMPLATE_DIR, "agent.role.md");
const PROGRESS_TEMPLATE_FILE = path.join(WORKSPACE_TEMPLATE_DIR, "agent.progress.md");

export interface AgentWorkspaceBootstrapResult {
  createdFiles: string[];
  skippedFiles: string[];
}

interface AgentFileSpec {
  relativePath: string;
  content: string;
  overwriteExisting?: boolean;
}

async function readOptionalTemplate(workspacePath: string, relativePath: string): Promise<string | undefined> {
  const target = path.resolve(workspacePath, relativePath);
  try {
    const raw = await fs.readFile(target, "utf8");
    const normalized = raw.replace(/^\uFEFF/, "").trim();
    return normalized.length > 0 ? normalized : undefined;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_m, keyRaw: string) => vars[keyRaw] ?? "");
}

export function buildAgentWorkspaceAgentsMd(hostPlatform?: HostPlatform): string {
  const runtimeGuide = getRuntimePlatformCapabilities(hostPlatform).agentWorkspaceGuide;
  return [
    "# AGENTS Runtime Guide",
    "",
    "## Startup Checklist",
    runtimeGuide,
    "1. Read `./role.md` for your role-specific objective and output contract.",
    "2. Read `./TEAM.md` to understand current team members.",
    "3. Use built-in ToolCalls directly:",
    "   - task_create_assign",
    "   - task_report_in_progress / task_report_done / task_report_block",
    "   - discuss_request / discuss_reply / discuss_close",
    "   - route_targets_get",
    "   - lock_manage",
    "4. All $env values are set in your runtime.",
    "",
    "## Task Progress Discipline (CRITICAL)",
    "- If you have an assigned task (taskId in your session), you MUST report progress via built-in ToolCalls: task_report_in_progress, task_report_done, task_report_block.",
    "- discuss_request/discuss_reply/discuss_close are for discuss flow only; they do NOT count as task progress.",
    "- Failure to report task progress will cause task to remain in 'granted' state indefinitely.",
    "",
    "## Error Handling (CRITICAL)",
    "- When a ToolCall fails, ALWAYS check the `error_code` field in the JSON output.",
    "- DO NOT infer error meaning from HTTP status codes alone (e.g., 409 does NOT always mean 'task already done').",
    "- The `hint` field provides actionable guidance - follow it exactly.",
    "- Common error codes:",
    "  - `TASK_PROGRESS_REQUIRED`: progress.md must include the task_id. Update progress.md and resend.",
    "  - `TASK_REPORT_NO_STATE_CHANGE`: Report would not change task state. Add new progress/evidence.",
    "  - `TASK_STATE_STALE`: Task is already in a newer terminal state. Keep same-state report or continue downstream work.",
    "  - `TASK_RESULT_INVALID_TARGET`: Task not owned by your role. Check task assignment.",
    "  - `TASK_BINDING_REQUIRED`: Missing required fields (task_id, owner_role, etc.).",
    "",
    "## Communication Contract",
    "- All communication MUST go through manager-routed ToolCalls.",
    "- Preserve envelope correlation fields and discuss thread metadata exactly.",
    "- If a discuss request expects reply, continue on the same thread first.",
    "- Reporting is accountability-driven: always report back to envelope.accountability.report_to.",
    "- Avoid duplicate task action/report payloads; one meaningful update per stage/task change.",
    "- If backend rejects duplicates, stop repeating and prepare one consolidated resend after real progress.",
    "- Never send low-signal updates (e.g. ping/ok/test); include concrete progress, blocker, evidence, or next action.",
    "- For TASK_CREATE/TASK_ASSIGN: keep `content` short (1-3 lines); put detailed scope into `write_set` / `acceptance` / `artifacts` / `dependencies`.",
    "- When assigning work, include related doc paths in `artifacts` (e.g. `docs/**`, design/migration notes) so assignee has traceable context.",
    "- Maintain local progress journal at `./progress.md` and update it before every task report.",
    "",
    "## File Placement",
    "- Shared docs/planning deliverables: write under `../../docs/`.",
    "- Shared implementation source code: write under `../../src/`.",
    "- Personal scratch/notes: keep inside current `./` directory.",
    "- Progress journal: `./progress.md` (status, changed files, evidence, blockers, next action).",
    "- Before editing a file in a shared team workspace, you must acquire a lock via `lock_manage(action=acquire)`.",
    "- Prefer file-level lock keys; use `target_type=dir` only when you truly need to protect a whole directory subtree.",
    "- Edit only after obtaining the lock and release it promptly upon completion to prevent concurrent edits."
  ].join("\n");
}

function formatTeamAgentLine(agentId: string, summary?: string): string {
  const normalizedSummary = summary?.trim();
  if (!normalizedSummary) {
    return `- [${agentId}](./${agentId}/)`;
  }
  return `- [${agentId}](./${agentId}/) - ${normalizedSummary}`;
}

function buildTeamIndexMd(agentIds: string[], agentSummaries?: Map<string, string>): string {
  return [
    "# Team Members",
    "",
    "This file lists all team members in this project.",
    "",
    "## Active Agents",
    ...agentIds.map((agentId) => formatTeamAgentLine(agentId, agentSummaries?.get(agentId))),
    "",
    "## Add a New Agent",
    "To add a new team agent:",
    "1. Request via manager-routed task/discuss ToolCalls",
    "2. Wait for Manager approval",
    "3. The new agent's workspace will be created automatically"
  ].join("\n");
}

function isPlanningRole(role: string): boolean {
  const lower = role.toLowerCase();
  return lower === "pm" || lower.startsWith("pm_") || lower.startsWith("planner") || lower.includes("product_manager");
}

function isEngineeringManagerRole(role: string): boolean {
  const lower = role.toLowerCase();
  return lower === "eng_manager" || lower === "devleader";
}

function isEngineerRole(role: string): boolean {
  const lower = role.toLowerCase();
  return lower === "engineer" || lower === "dev_agent" || lower.endsWith("_engineer");
}

function isQaRole(role: string): boolean {
  const lower = role.toLowerCase();
  return lower === "qa" || lower === "qa_guard" || lower.startsWith("qa_") || lower.endsWith("_qa");
}

function buildDefaultRolePrompt(role: string): string {
  if (isPlanningRole(role)) {
    return [
      "Role objective:",
      "- Own requirement and planning quality; produce executable docs under ../../docs/**.",
      "- Do not write production implementation in ../../src/**.",
      "- Create and assign execution tasks to engineering roles with explicit acceptance and write_set.",
      "- In TASK_ASSIGN, reference requirement/design docs via artifacts paths; keep content concise and structured.",
      "",
      "Reporting contract:",
      "- Report concise status to manager route owner.",
      "- If task action/report is duplicated, consolidate updates and resend once with new evidence."
    ].join("\n");
  }

  if (isEngineeringManagerRole(role)) {
    return [
      "Role objective:",
      "- Own engineering decomposition, execution sequencing, and quality gate decisions.",
      "- Route concrete implementation tasks to engineer roles and track completion evidence.",
      "- In assignment actions, attach doc paths (design/spec/migration) in artifacts instead of long content blocks.",
      "- QA phase gate: QA can write test plan/cases during planning, but test execution starts only after all engineering tasks are marked complete.",
      "- Trigger QA execution only when implementation completion evidence is collected for all required tasks.",
      "",
      "Reporting contract:",
      "- Aggregate engineer updates and send a single consolidated progress report per milestone.",
      "- If duplicate report is rejected, do not resend immediately; merge delta and resend once."
    ].join("\n");
  }

  if (isEngineerRole(role)) {
    return [
      "Role objective:",
      "- Implement assigned tasks in ../../src/** and update required docs/evidence.",
      "- Follow lock discipline and keep write_set explicit.",
      "",
      "Reporting contract:",
      "- Report back to assigned manager owner with changed files, acceptance evidence, and blockers.",
      "- Avoid repeated duplicate reports; send one merged update when progress changes."
    ].join("\n");
  }

  if (isQaRole(role)) {
    return [
      "Role objective:",
      "- During planning stage, author test strategy and test cases only.",
      "- Execute tests only after engineering manager confirms implementation completion and requests QA execution.",
      "- Report test evidence and failed acceptance items with precise reproduction notes.",
      "",
      "Reporting contract:",
      "- Return results to accountability.report_to role/session.",
      "- When duplicate report is rejected, merge findings and resend one consolidated report."
    ].join("\n");
  }

  return [
    "Role objective:",
    "- Deliver role-owned outputs with explicit files and acceptance evidence.",
    "- Use manager routing and discuss protocol to collaborate.",
    "",
    "Reporting contract:",
    "- Respect accountability.report_to.",
    "- Merge duplicate updates and resend once after meaningful progress."
  ].join("\n");
}

function buildRoleBoundaryLines(role: string): string[] {
  if (isPlanningRole(role)) {
    return [
      "## Role Boundary",
      "- You are a planning/management role; do not implement production code in ../../src/**.",
      "- Finalize requirements/plans, then create/assign execution tasks to engineering roles via ToolCalls.",
      "- If discuss reaches route max rounds, document assumptions/risks and decide whether to continue or mark blocked."
    ];
  }

  if (isEngineeringManagerRole(role)) {
    return [
      "## Role Boundary",
      "- You are an engineering coordination role; prioritize task decomposition, ownership, and quality gates.",
      "- Do not absorb all implementation yourself; route executable work to engineer roles.",
      "- Keep planning source-of-truth in ../../docs/** and implementation ownership in ../../src/** by engineer roles.",
      "- QA phase gate: QA can draft cases in planning stage, but QA execution is allowed only after all assigned engineering tasks are complete."
    ];
  }

  if (isEngineerRole(role)) {
    return [
      "## Role Boundary",
      "- You are an implementation role; production code should be placed under ../../src/**.",
      "- Keep requirements/planning source-of-truth in ../../docs/** and report status through ToolCalls."
    ];
  }

  if (isQaRole(role)) {
    return [
      "## Role Boundary",
      "- During planning stage, only prepare test strategy/cases under ../../docs/**.",
      "- Do not run execution test pass before engineering completion gate from eng_manager.",
      "- After gate is open, run validation and report evidence and defects with explicit traceability."
    ];
  }

  return [
    "## Role Boundary",
    "- Use role objective to decide docs work (../../docs/**) vs code work (../../src/**).",
    "- If this role is not the best executor, handoff to an allowed target role instead of force-solving in place."
  ];
}

function buildRoleMdTemplate(role: string, prompt: string): string {
  const promptTrimmed = prompt.trim();
  const promptMissing = promptTrimmed.length === 0;
  const normalizedPrompt = promptMissing ? buildDefaultRolePrompt(role) : promptTrimmed;
  const boundaryLines = buildRoleBoundaryLines(role);
  return [
    `# Role: ${role}`,
    "",
    "This file is the source of truth for your role behavior.",
    "",
    "## Mission",
    "- Operate as a team role in a routed multi-agent workflow.",
    "- Produce concrete deliverables under ../../docs/ and report through manager routing.",
    "",
    "## How To Operate",
    "- Read ./AGENTS.md first for runtime communication/tooling rules.",
    "- Use built-in ToolCalls for task actions, discuss, route query, and lock discipline.",
    "- Never bypass envelope/correlation metadata when replying or handing off.",
    "",
    "## Reporting Rules",
    "- Report to envelope.accountability.report_to (role/session) whenever provided.",
    "- Keep reports and task actions stage-based: one meaningful update per milestone or state transition.",
    "- For TASK_CREATE/TASK_ASSIGN, keep content concise and move detailed scope into write_set/acceptance/artifacts/dependencies.",
    "- Prefer explicit doc file paths in artifacts when assigning work (docs/**, design docs, migration notes).",
    "- If backend returns duplicate, do not spam retries.",
    "- For duplicate rejection, merge incremental progress into one final resend with updated evidence and changed files.",
    "- Before any task report, update `./progress.md` with latest status/evidence/next action.",
    "",
    "## Progress Journal",
    "- Keep `./progress.md` in this workspace as the role-local execution log.",
    "- Minimum sections per update: status, changed files, evidence commands/results, blockers, next action.",
    "- Every outgoing task action/report must be traceable to the latest progress log entry.",
    "",
    ...boundaryLines,
    "",
    "## Tool Reference",
    "Tool schemas are exposed directly by runtime tool registry. Use exact names from the available tools list.",
    "",
    "## Prompt Integrity",
    promptMissing
      ? "- WARNING: role prompt seed missing in registry for this role. Fallback role template is active."
      : "- Role prompt seed loaded from agent registry.",
    "",
    "---",
    "## Current Role Prompt",
    normalizedPrompt
  ].join("\n");
}

function buildProgressTemplate(role: string): string {
  return [
    `# Progress - ${role}`,
    "",
    "Update this file before each handoff/report.",
    "",
    "## Current Status",
    "- state: TODO|DOING|BLOCKED|DONE",
    "- task_id: <task_id>",
    "- summary: <one-line progress>",
    "",
    "## Changed Files",
    "- <relative/path>",
    "",
    "## Evidence",
    "- command: <cmd>",
    "- result: <key output>",
    "",
    "## Blockers",
    "- <none or blocker details>",
    "",
    "## Next Action",
    "- <next concrete step>",
    ""
  ].join("\n");
}

function buildAgentWorkspaceReadme(role: string): string {
  return [
    `# ${role} Workspace`,
    "",
    "This is your personal workspace directory.",
    "",
    "## Use this directory for:",
    "- Your working notes and drafts",
    "- Temporary files that don't need to be shared",
    "- Your own progress tracking",
    "",
    "## DO NOT use this directory for:",
    "- Project-wide documentation (use ../../docs/)",
    "- Shared deliverables",
    "- Files that other agents need to access",
    "",
    "## Files",
    "- `role.md`: Read this to understand your role in the team"
  ].join("\n");
}

async function upsertManagedFile(
  workspacePath: string,
  spec: AgentFileSpec,
  result: AgentWorkspaceBootstrapResult
): Promise<void> {
  const absolutePath = path.resolve(workspacePath, spec.relativePath);
  const expectedContent = `\uFEFF${spec.content}\n`;
  let existingContent: string | undefined;
  try {
    existingContent = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code && known.code !== "ENOENT") {
      throw error;
    }
  }

  if (existingContent !== undefined) {
    if (
      existingContent === expectedContent ||
      existingContent === spec.content ||
      existingContent === `${spec.content}\n`
    ) {
      result.skippedFiles.push(spec.relativePath);
      return;
    }
    if (!spec.overwriteExisting) {
      result.skippedFiles.push(spec.relativePath);
      return;
    }
  }

  await ensureDirectory(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, expectedContent, "utf8");
  result.createdFiles.push(spec.relativePath);
}

export async function ensureTeamIndex(
  project: ProjectRecord,
  agentSummaries?: Map<string, string>
): Promise<AgentWorkspaceBootstrapResult> {
  const result: AgentWorkspaceBootstrapResult = {
    createdFiles: [],
    skippedFiles: []
  };

  await ensureDirectory(project.workspacePath);
  const agentsRoot = path.join(project.workspacePath, AGENTS_DIR);
  await ensureDirectory(agentsRoot);

  const agentIds = project.agentIds ?? [];
  const template = await readOptionalTemplate(project.workspacePath, TEAM_TEMPLATE_FILE);
  const defaultList = agentIds.map((agentId) => formatTeamAgentLine(agentId, agentSummaries?.get(agentId))).join("\n");
  const spec: AgentFileSpec = {
    relativePath: path.join(AGENTS_DIR, "TEAM.md"),
    overwriteExisting: true,
    content:
      template && template.length > 0
        ? renderTemplate(template, {
            AGENT_LIST: defaultList
          })
        : buildTeamIndexMd(agentIds, agentSummaries)
  };

  await upsertManagedFile(project.workspacePath, spec, result);
  return result;
}

export async function ensureAgentWorkspaces(
  project: ProjectRecord,
  agentPrompts: Map<string, string>,
  requiredAgentIds?: string[],
  agentSummaries?: Map<string, string>
): Promise<AgentWorkspaceBootstrapResult> {
  const result: AgentWorkspaceBootstrapResult = {
    createdFiles: [],
    skippedFiles: []
  };

  await ensureDirectory(project.workspacePath);
  const agentsRoot = path.join(project.workspacePath, AGENTS_DIR);
  await ensureDirectory(agentsRoot);

  const mergedAgentIds = [...(project.agentIds ?? []), ...(requiredAgentIds ?? [])]
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const agentIds = Array.from(new Set(mergedAgentIds));
  const [agentGuideTemplate, roleTemplate, progressTemplate] = await Promise.all([
    readOptionalTemplate(project.workspacePath, AGENT_GUIDE_TEMPLATE_FILE),
    readOptionalTemplate(project.workspacePath, ROLE_TEMPLATE_FILE),
    readOptionalTemplate(project.workspacePath, PROGRESS_TEMPLATE_FILE)
  ]);
  for (const role of agentIds) {
    const agentDir = path.join(AGENTS_DIR, role);
    const rolePrompt = agentPrompts.get(role) ?? "";
    const rolePromptTrimmed = rolePrompt.trim();
    const promptMissing = rolePromptTrimmed.length === 0;
    if (promptMissing) {
      throw new Error(`[agent-workspace] role prompt missing for role='${role}'. role.md generation blocked.`);
    }
    const normalizedRolePrompt = rolePromptTrimmed;
    const roleBoundary = buildRoleBoundaryLines(role).join("\n");
    const promptIntegrity = promptMissing
      ? "- WARNING: role prompt seed missing in registry for this role. Fallback role template is active."
      : "- Role prompt seed loaded from agent registry.";

    const specs: AgentFileSpec[] = [
      {
        relativePath: path.join(agentDir, "AGENTS.md"),
        overwriteExisting: false,
        content:
          agentGuideTemplate && agentGuideTemplate.length > 0
            ? renderTemplate(agentGuideTemplate, {
                ROLE: role
              })
            : buildAgentWorkspaceAgentsMd()
      },
      {
        relativePath: path.join(agentDir, "role.md"),
        overwriteExisting: false,
        content:
          roleTemplate && roleTemplate.length > 0
            ? renderTemplate(roleTemplate, {
                ROLE: role,
                ROLE_PROMPT: normalizedRolePrompt,
                ROLE_BOUNDARY: roleBoundary,
                PROMPT_INTEGRITY: promptIntegrity
              })
            : buildRoleMdTemplate(role, rolePrompt)
      },
      {
        relativePath: path.join(agentDir, "progress.md"),
        overwriteExisting: false,
        content:
          progressTemplate && progressTemplate.length > 0
            ? renderTemplate(progressTemplate, {
                ROLE: role
              })
            : buildProgressTemplate(role)
      }
    ];

    for (const spec of specs) {
      await upsertManagedFile(project.workspacePath, spec, result);
    }
  }

  await ensureTeamIndex(project, agentSummaries);

  return result;
}
