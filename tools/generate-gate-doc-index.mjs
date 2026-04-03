import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseCliArgs(argv) {
  const map = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : "true";
    map.set(key, value);
    if (value !== "true") {
      index += 1;
    }
  }
  return map;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function parseSummary(summary) {
  const lines = summary.split("\n");
  const steps = {};
  let timestamp = "";
  let currentStep = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const tsMatch = line.match(/^- timestamp:\s*(.+)$/);
    if (tsMatch) {
      timestamp = tsMatch[1].trim();
      continue;
    }
    const stepMatch = line.match(/^##\s+(.+)$/);
    if (stepMatch) {
      currentStep = stepMatch[1].trim();
      steps[currentStep] = steps[currentStep] ?? { success: null, exit_code: null };
      continue;
    }
    if (!currentStep) {
      continue;
    }
    const successMatch = line.match(/^- success:\s*(.+)$/);
    if (successMatch) {
      const value = successMatch[1].trim().toLowerCase();
      steps[currentStep].success = value === "true";
      continue;
    }
    const exitCodeMatch = line.match(/^- exit_code:\s*(.+)$/);
    if (exitCodeMatch) {
      const parsed = Number.parseInt(exitCodeMatch[1].trim(), 10);
      steps[currentStep].exit_code = Number.isNaN(parsed) ? null : parsed;
    }
  }
  return { timestamp, steps };
}

async function listReleaseReports(docsDir) {
  const entries = await fs.readdir(docsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^release_qa_report_\d{8}\.md$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseKnownExternalIssue(reportContent) {
  if (!reportContent) {
    return "";
  }
  const lines = reportContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(external|provider|MiniMax|overloaded_error|outage|instability)/i.test(line));
  const unique = Array.from(new Set(lines));
  return unique.slice(0, 3).join(" | ");
}

async function selectQaReport({ docsDir, runDate, commit }) {
  const reports = await listReleaseReports(docsDir);
  if (reports.length === 0) {
    return { reportPath: "", reportContent: "" };
  }
  const normalizedCommit = typeof commit === "string" ? commit.trim() : "";
  if (!normalizedCommit) {
    return { reportPath: "", reportContent: "" };
  }
  const preferredByDate = runDate ? `release_qa_report_${runDate}.md` : "";
  const fullCommit = normalizedCommit;
  const shortCommit = normalizedCommit.slice(0, 7);

  const reportCandidates = [];
  if (preferredByDate && reports.includes(preferredByDate)) {
    reportCandidates.push(preferredByDate);
  }
  for (const name of reports) {
    if (!reportCandidates.includes(name)) {
      reportCandidates.push(name);
    }
  }

  for (const reportName of reportCandidates) {
    const absolutePath = path.join(docsDir, reportName);
    const content = await readIfExists(absolutePath);
    if (!content) {
      continue;
    }
    if (content.includes(fullCommit) || (shortCommit && content.includes(shortCommit))) {
      return { reportPath: absolutePath, reportContent: content };
    }
  }
  return { reportPath: "", reportContent: "" };
}

function toRelativePosix(repoRoot, targetPath) {
  if (!targetPath) {
    return "";
  }
  return path.relative(repoRoot, targetPath).replaceAll("\\", "/");
}

function stringifyMarkdown(result) {
  const lines = [];
  lines.push("# Gate -> Docs Index");
  lines.push("");
  lines.push(`- run_time: ${result.run_time}`);
  lines.push(`- branch: ${result.branch}`);
  lines.push(`- commit: ${result.commit}`);
  lines.push(`- gate_summary_path: ${result.gate_summary_path}`);
  lines.push(`- qa_report_path: ${result.qa_report_path || "N/A"}`);
  lines.push(`- waiver_applied: ${result.waiver_applied}`);
  lines.push(`- known_external_issue: ${result.known_external_issue || "none"}`);
  lines.push("");
  lines.push("## Baseline Results");
  lines.push("");
  lines.push(`- smoke: success=${result.smoke.success} exit_code=${result.smoke.exit_code}`);
  lines.push(`- project: success=${result.project.success} exit_code=${result.project.exit_code}`);
  lines.push(`- workflow: success=${result.workflow.success} exit_code=${result.workflow.exit_code}`);
  return lines.join("\n");
}

async function resolveSummaryPath(repoRoot, cliArgs) {
  const explicit = cliArgs.get("summary");
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(repoRoot, explicit);
  }
  const gateRoot = path.join(repoRoot, ".e2e-workspace", "standard-gate");
  const entries = await fs.readdir(gateRoot, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (dirs.length === 0) {
    throw new Error("no standard-gate output directory found");
  }
  return path.join(gateRoot, dirs[0], "run_summary.md");
}

async function main() {
  const repoRoot = process.cwd();
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const summaryPath = await resolveSummaryPath(repoRoot, cliArgs);
  const summaryContent = await fs.readFile(summaryPath, "utf8");
  const summary = parseSummary(summaryContent);
  const runDate = summary.timestamp ? summary.timestamp.slice(0, 8) : "";
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const commit = runGit(["rev-parse", "HEAD"], repoRoot);

  const docsDir = path.join(repoRoot, "docs");
  const qaSelection = await selectQaReport({ docsDir, runDate, commit });
  const qaRelativePath = toRelativePosix(repoRoot, qaSelection.reportPath);
  const waiverApplied = /PASS by waiver|waiver/i.test(qaSelection.reportContent);
  const knownExternalIssue = parseKnownExternalIssue(qaSelection.reportContent);

  const step = (name) => summary.steps[name] ?? { success: null, exit_code: null };
  const result = {
    run_time: summary.timestamp,
    branch,
    commit,
    smoke: step("smoke"),
    project: step("project_core_e2e"),
    workflow: step("workflow_core_e2e"),
    qa_report_path: qaRelativePath,
    waiver_applied: waiverApplied,
    known_external_issue: knownExternalIssue,
    gate_summary_path: toRelativePosix(repoRoot, summaryPath)
  };

  const gateOutDir = path.dirname(summaryPath);
  const indexJsonPath = path.join(gateOutDir, "gate_doc_index.json");
  const indexMdPath = path.join(gateOutDir, "gate_doc_index.md");
  await fs.writeFile(indexJsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await fs.writeFile(indexMdPath, `${stringifyMarkdown(result)}\n`, "utf8");

  console.log(`gate_doc_index_json=${indexJsonPath}`);
  console.log(`gate_doc_index_md=${indexMdPath}`);
  console.log(`commit=${result.commit}`);
  console.log(`smoke_success=${result.smoke.success} smoke_exit_code=${result.smoke.exit_code}`);
  console.log(`project_success=${result.project.success} project_exit_code=${result.project.exit_code}`);
  console.log(`workflow_success=${result.workflow.success} workflow_exit_code=${result.workflow.exit_code}`);
  console.log(`qa_report_path=${result.qa_report_path || "N/A"}`);
  console.log(`waiver_applied=${result.waiver_applied}`);
  console.log(`known_external_issue=${result.known_external_issue || "none"}`);
}

main().catch((error) => {
  console.error(`[generate-gate-doc-index] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
