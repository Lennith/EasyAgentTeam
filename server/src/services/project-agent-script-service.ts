﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRecord } from "../domain/models.js";
import { ensureDirectory } from "../data/file-utils.js";

export interface AgentScriptBootstrapResult {
  createdFiles: string[];
  skippedFiles: string[];
}

export const AGENT_TOOLS_DIR = "TeamTools";
export const AGENT_TOOLCHAIN_VERSION = "teamtools-v4";

export class TeamToolsTemplateError extends Error {
  constructor(
    message: string,
    public readonly code: "TEAMTOOLS_TEMPLATE_NOT_FOUND"
  ) {
    super(message);
  }
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

async function existsDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function existsFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function walkFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relative = normalizePath(path.relative(rootDir, absolute));
      result.push(relative);
    }
  }

  result.sort((a, b) => a.localeCompare(b));
  return result;
}

async function resolveTeamToolsTemplateSource(): Promise<string> {
  const envOverride = process.env.AUTO_DEV_TEAMTOOLS_SOURCE?.trim();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];

  if (envOverride) {
    const override = path.resolve(envOverride);
    if (!(await existsDirectory(override))) {
      throw new TeamToolsTemplateError(
        `TEAMTOOLS_TEMPLATE_NOT_FOUND: AUTO_DEV_TEAMTOOLS_SOURCE does not exist: ${override}`,
        "TEAMTOOLS_TEMPLATE_NOT_FOUND"
      );
    }
    const listFile = path.join(override, "TeamToolsList.md");
    if (!(await existsFile(listFile))) {
      throw new TeamToolsTemplateError(
        `TEAMTOOLS_TEMPLATE_NOT_FOUND: invalid TeamTools template at ${override}. Expected TeamToolsList.md`,
        "TEAMTOOLS_TEMPLATE_NOT_FOUND"
      );
    }
    return override;
  }

  candidates.push(path.resolve(process.cwd(), "TeamsTools"));
  candidates.push(path.resolve(process.cwd(), "..", "TeamsTools"));
  candidates.push(path.resolve(moduleDir, "../../../TeamsTools"));
  candidates.push(path.resolve(moduleDir, "../../../../TeamsTools"));

  for (const candidate of candidates) {
    if (!(await existsDirectory(candidate))) {
      continue;
    }
    const listFile = path.join(candidate, "TeamToolsList.md");
    if (await existsFile(listFile)) {
      return candidate;
    }
  }

  throw new TeamToolsTemplateError(
    "TEAMTOOLS_TEMPLATE_NOT_FOUND: cannot resolve TeamTools template source. Expected TeamToolsList.md",
    "TEAMTOOLS_TEMPLATE_NOT_FOUND"
  );
}

function shouldCopyTeamToolsFile(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  const lower = normalized.toLowerCase();
  if (lower.endsWith(".md")) {
    return true;
  }
  if (lower.endsWith(".yml") || lower.endsWith(".yaml") || lower.endsWith(".json")) {
    return true;
  }
  return false;
}

async function cleanupLegacyScriptArtifacts(workspacePath: string): Promise<void> {
  const legacyRelativePaths = [
    "autodev_handoff.ps1",
    "autodev_clarify.ps1",
    "autodev_route_targets.ps1",
    "autodev_lock.ps1",
    "devtools",
    "DevTools"
  ];
  for (const legacyPath of legacyRelativePaths) {
    const absolutePath = path.join(workspacePath, ...legacyPath.split("/"));
    try {
      await fs.rm(absolutePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function ensureProjectAgentScripts(project: ProjectRecord): Promise<AgentScriptBootstrapResult> {
  const result: AgentScriptBootstrapResult = {
    createdFiles: [],
    skippedFiles: []
  };

  await ensureDirectory(project.workspacePath);
  await cleanupLegacyScriptArtifacts(project.workspacePath);

  const sourceRoot = await resolveTeamToolsTemplateSource();
  const sourceFiles = await walkFiles(sourceRoot);
  const targetRoot = path.join(project.workspacePath, AGENT_TOOLS_DIR);
  await ensureDirectory(targetRoot);

  for (const relativePath of sourceFiles) {
    if (!shouldCopyTeamToolsFile(relativePath)) {
      continue;
    }
    const sourceFile = path.join(sourceRoot, ...relativePath.split("/"));
    const targetFile = path.join(targetRoot, ...relativePath.split("/"));
    await ensureDirectory(path.dirname(targetFile));

    const sourceBuffer = await fs.readFile(sourceFile);
    try {
      const existingBuffer = await fs.readFile(targetFile);
      if (existingBuffer.equals(sourceBuffer)) {
        result.skippedFiles.push(`${AGENT_TOOLS_DIR}/${relativePath}`);
        continue;
      }
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code && known.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.writeFile(targetFile, sourceBuffer);
    result.createdFiles.push(`${AGENT_TOOLS_DIR}/${relativePath}`);
  }

  return result;
}
