import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectRecord } from "../domain/models.js";
import { ensureDirectory } from "../data/file-utils.js";

export interface ProjectTemplateApplyResult {
  templateId: string;
  applied: boolean;
  createdFiles: string[];
  skippedFiles: string[];
}

interface TemplateFileSpec {
  relativePath: string;
  content: string;
}

const REPO_DOC_FLOW_FILES: TemplateFileSpec[] = [
  {
    relativePath: "docs/README.md",
    content: `
# Project Documentation Workspace

This repository template is designed for role-based collaboration.

- PM writes product requirements in \`docs/requirements/product_requirements.md\`
- planner writes implementation and API plans in \`docs/planning/\`
- devleader splits executable tasks in \`docs/tasks/devleader_task_breakdown.md\`
- dev agents report status in \`docs/status/dev_progress_updates.md\`

All roles must request file locks before editing and report changed files in final reports.
`.trim()
  },
  {
    relativePath: "docs/requirements/product_requirements.md",
    content: `
# Product Requirements (PM)

## Goal
- Business objective
- User problem to solve

## Scope
- In scope
- Out of scope

## Functional Requirements
1. Requirement
2. Requirement

## Acceptance Criteria
- [ ] Criterion
- [ ] Criterion

## Risks and Open Questions
- Risk:
- Question:
`.trim()
  },
  {
    relativePath: "docs/planning/development_plan.md",
    content: `
# Development Plan (planner)

## Architecture Summary
- Components
- Data flow
- Dependencies

## Milestones
1. Milestone with deliverables
2. Milestone with deliverables

## Validation Plan
- Unit tests
- Integration tests
- Rollout checks
`.trim()
  },
  {
    relativePath: "docs/planning/api_interface_design.md",
    content: `
# API Interface Design (planner)

## API Catalog
- Endpoint
- Method
- Request schema
- Response schema

## Error Handling
- Error code
- Retry behavior

## Compatibility
- Versioning strategy
- Backward compatibility notes
`.trim()
  },
  {
    relativePath: "docs/tasks/devleader_task_breakdown.md",
    content: `
# Task Breakdown (devleader)

## Task List
- task_id:
  - owner_role:
  - write_set:
  - dependencies:
  - acceptance:

## Assignment Rules
- Assign each task to one dev role.
- Keep write_set explicit and minimal.
- Require progress updates from dev agents after each milestone.
`.trim()
  },
  {
    relativePath: "docs/status/dev_progress_updates.md",
    content: `
# Dev Progress Updates (dev agents)

## Update Template
- agent_id:
- task_id:
- status: TODO | DOING | WAITING_NEXT | DONE | BLOCKED
- changed_files:
- lock_keys_used:
- summary:
- blockers:

Each update must be sent to devleader through manager routing.
`.trim()
  },
  {
    relativePath: "docs/process/locking_and_reporting.md",
    content: `
# Lock and Reporting Rules (MANDATORY)

## Overview
All execution roles (engineer, dev_agent, etc.) MUST follow lock discipline when editing files.
Lock is MANDATORY, not optional.

## Before Editing (MANDATORY)
1. Identify files you need to edit from task's write_set
2. For EACH file, acquire lock via lock.ps1:
   \`\`\`powershell
   powershell -ExecutionPolicy Bypass -File ..\\..\\TeamTools\\lock.ps1 -Action acquire -LockContentPath "src/path/to/file.ts" -TargetType file -Purpose "implementing feature X"
   \`\`\`
3. Verify output shows \`"result": "acquired"\` before proceeding
4. If lock fails with LOCK_HELD, coordinate with lock owner or wait
5. NEVER proceed with edits without acquiring lock first

## During Work
1. Only edit files you have successfully locked
2. Keep write_set aligned with locked paths
3. Renew locks if work takes longer than TTL (default 30 min):
   \`\`\`powershell
   powershell -ExecutionPolicy Bypass -File ..\\..\\TeamTools\\lock.ps1 -Action renew -LockContentPath "src/path/to/file.ts"
   \`\`\`
4. Document locked files in your progress.md

## After Work (MANDATORY)
1. Report changed files in TASK_REPORT
2. Release ALL locks you acquired:
   \`\`\`powershell
   powershell -ExecutionPolicy Bypass -File ..\\..\\TeamTools\\lock.ps1 -Action release -LockContentPath "src/path/to/file.ts"
   \`\`\`
3. If handoff is needed, provide suggest_next_actions to target role
4. Update progress.md with lock release status

## Lock Status in progress.md
Always maintain a "Locked Files" section:
\`\`\`
## Locked Files
- src/utils/helper.ts: acquired
- src/components/Button.tsx: acquired
\`\`\`

## Violation Consequences
- Editing files without lock may cause conflicts with other agents
- Lock violations will be visible in dashboard and audit logs
`.trim()
  }
];

async function writeMarkdownFileIfMissing(
  workspacePath: string,
  spec: TemplateFileSpec,
  result: ProjectTemplateApplyResult
): Promise<void> {
  const absolutePath = path.resolve(workspacePath, spec.relativePath);
  try {
    await fs.access(absolutePath);
    result.skippedFiles.push(spec.relativePath);
    return;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code && known.code !== "ENOENT") {
      throw error;
    }
  }
  await ensureDirectory(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, `\uFEFF${spec.content}\n`, "utf8");
  result.createdFiles.push(spec.relativePath);
}

export async function applyProjectTemplate(project: ProjectRecord): Promise<ProjectTemplateApplyResult> {
  const templateId = (project.templateId ?? "none").trim() || "none";
  const result: ProjectTemplateApplyResult = {
    templateId,
    applied: false,
    createdFiles: [],
    skippedFiles: []
  };

  if (templateId !== "repo_doc_flow") {
    return result;
  }

  await ensureDirectory(project.workspacePath);
  for (const spec of REPO_DOC_FLOW_FILES) {
    await writeMarkdownFileIfMissing(project.workspacePath, spec, result);
  }
  result.applied = true;
  return result;
}
