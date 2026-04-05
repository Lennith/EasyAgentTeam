import path from "node:path";
import { DEFAULT_REPORT_ROOT } from "./constants.mjs";
import { ensureDir, writeJsonFile, writeTextFile } from "./utils/file-utils.mjs";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Agent Workspace Import Report");
  lines.push("");
  lines.push(`- time: ${report.time}`);
  lines.push(`- mode: ${report.mode}`);
  lines.push(`- status: ${report.status}`);
  lines.push(`- bundle_id: ${report.bundle_id}`);
  lines.push(`- base_url: ${report.base_url}`);
  lines.push(`- dry_run: ${report.dry_run}`);
  lines.push("");

  if (report.validation_errors?.length > 0) {
    lines.push("## Validation Errors");
    for (const item of report.validation_errors) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (report.validation_warnings?.length > 0) {
    lines.push("## Validation Warnings");
    for (const item of report.validation_warnings) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  lines.push("## Steps");
  for (const step of report.steps ?? []) {
    lines.push(`- ${step.module}: ${step.status}`);
  }
  lines.push("");

  lines.push("## Created Resources");
  const created = report.created_resources ?? {};
  lines.push(`- skills: ${(created.skills ?? []).join(", ") || "(none)"}`);
  lines.push(`- skill_lists: ${(created.skill_lists ?? []).join(", ") || "(none)"}`);
  lines.push(`- agents: ${(created.agents ?? []).join(", ") || "(none)"}`);
  lines.push(`- project_id: ${created.project_id ?? "(none)"}`);
  lines.push(`- workflow_template_id: ${created.workflow_template_id ?? "(none)"}`);
  lines.push(`- workflow_run_id: ${created.workflow_run_id ?? "(none)"}`);
  lines.push("");

  if (report.rollback?.length > 0) {
    lines.push("## Rollback");
    for (const item of report.rollback) {
      lines.push(`- ${item.action}: ${item.status} (${item.id})`);
    }
    lines.push("");
  }

  if (report.error) {
    lines.push("## Error");
    lines.push(`- ${report.error.message}`);
    lines.push(`- code: ${report.error.code}`);
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function writeReport(repoRoot, bundleId, report) {
  const folderName = `${nowStamp()}-${bundleId}`;
  const reportDir = path.join(repoRoot, DEFAULT_REPORT_ROOT, folderName);
  await ensureDir(reportDir);

  const jsonPath = path.join(reportDir, "import_report.json");
  const mdPath = path.join(reportDir, "import_report.md");
  await writeJsonFile(jsonPath, report);
  await writeTextFile(mdPath, toMarkdown(report));

  return { reportDir, jsonPath, mdPath };
}

