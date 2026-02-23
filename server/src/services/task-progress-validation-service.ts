import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectRecord, TaskReport } from "../domain/models.js";

export class TaskProgressValidationError extends Error {
  constructor(
    message: string,
    public readonly code: "TASK_PROGRESS_REQUIRED"
  ) {
    super(message);
  }
}

function hasTemplatePlaceholder(content: string): boolean {
  const placeholders = ["<task_id>", "<one-line progress>", "<relative/path>", "state: TODO|DOING|BLOCKED|DONE"];
  return placeholders.some((item) => content.includes(item));
}

function hasWeakProgressEvidence(report: TaskReport): boolean {
  if (report.summary.trim().length > 0) {
    return true;
  }
  return report.results.some(
    (row) =>
      (row.summary && row.summary.trim().length > 0) ||
      (Array.isArray(row.blockers) && row.blockers.length > 0) ||
      (Array.isArray(row.artifacts) && row.artifacts.length > 0)
  );
}

export async function validateAgentProgressFile(
  project: ProjectRecord,
  fromAgent: string,
  report: TaskReport,
  options?: {
    resultTaskIds?: string[];
  }
): Promise<void> {
  const targetTaskIds =
    options?.resultTaskIds && options.resultTaskIds.length > 0 ? new Set(options.resultTaskIds) : null;
  const effectiveReport: TaskReport =
    targetTaskIds === null
      ? report
      : {
          ...report,
          results: report.results.filter((row) => targetTaskIds.has(row.taskId))
        };

  if (effectiveReport.results.length === 0) {
    return;
  }

  // If report already includes summary/blockers/artifacts, accept it directly.
  if (hasWeakProgressEvidence(effectiveReport)) {
    return;
  }

  const progressFile = path.resolve(project.workspacePath, "Agents", fromAgent, "progress.md");
  let content = "";
  try {
    content = await fs.readFile(progressFile, "utf8");
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      throw new TaskProgressValidationError("progress.md is required before TASK_REPORT", "TASK_PROGRESS_REQUIRED");
    }
    throw error;
  }

  const trimmed = content.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new TaskProgressValidationError("progress.md must not be empty", "TASK_PROGRESS_REQUIRED");
  }
  if (hasTemplatePlaceholder(trimmed)) {
    throw new TaskProgressValidationError(
      "progress.md contains placeholder template content; update it before TASK_REPORT",
      "TASK_PROGRESS_REQUIRED"
    );
  }

  const missing = effectiveReport.results.filter((row) => !trimmed.includes(row.taskId));
  if (missing.length > 0) {
    return;
  }
}
