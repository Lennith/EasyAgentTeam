import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { Dirent, Stats } from "node:fs";
import type {
  SkillDefinition,
  SkillListDefinition,
  SkillListRegistryState,
  SkillRegistryState
} from "../domain/models.js";
import { ensureDirectory } from "./file-utils.js";
import { readJsonFile, writeJsonFile } from "./store/store-runtime.js";

const SKILL_FILE = "SKILL.md";

export class SkillStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_SKILL_ID"
      | "SKILL_NOT_FOUND"
      | "INVALID_SOURCE_PATH"
      | "IMPORT_SOURCE_NOT_FOUND"
      | "INVALID_LIST_ID"
      | "SKILL_LIST_EXISTS"
      | "SKILL_LIST_NOT_FOUND"
      | "INVALID_SKILL_REFERENCE"
  ) {
    super(message);
  }
}

export interface SkillImportItem {
  skill: SkillDefinition;
  action: "created" | "updated";
  warnings: string[];
}

export interface SkillImportResult {
  imported: SkillImportItem[];
  warnings: string[];
}

export interface SkillPromptSegmentResolveResult {
  segments: string[];
  resolvedSkillIds: string[];
  missingSkillIds: string[];
  warnings: string[];
}

function skillsRoot(dataRoot: string): string {
  return path.join(dataRoot, "skills");
}

function skillRegistryPath(dataRoot: string): string {
  return path.join(skillsRoot(dataRoot), "registry.json");
}

function skillListRegistryPath(dataRoot: string): string {
  return path.join(skillsRoot(dataRoot), "lists.json");
}

function skillPackagesRoot(dataRoot: string): string {
  return path.join(skillsRoot(dataRoot), "packages");
}

function defaultSkillRegistry(): SkillRegistryState {
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    skills: []
  };
}

function defaultSkillListRegistry(): SkillListRegistryState {
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    lists: []
  };
}

function normalizeSkillId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new SkillStoreError("skill_id is invalid", "INVALID_SKILL_ID");
  }
  return normalized;
}

function normalizeListId(raw: string): string {
  const normalized = raw.trim();
  if (!normalized || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new SkillStoreError("list_id is invalid", "INVALID_LIST_ID");
  }
  return normalized;
}

function normalizeSkillIds(raw: string[] | undefined): string[] {
  if (!raw) {
    return [];
  }
  const values = raw.map((item) => item.trim()).filter((item) => item.length > 0);
  return Array.from(new Set(values));
}

async function readSkillRegistry(dataRoot: string): Promise<SkillRegistryState> {
  return readJsonFile<SkillRegistryState>(skillRegistryPath(dataRoot), defaultSkillRegistry());
}

async function writeSkillRegistry(dataRoot: string, registry: SkillRegistryState): Promise<void> {
  await writeJsonFile(skillRegistryPath(dataRoot), registry);
}

async function readSkillListRegistry(dataRoot: string): Promise<SkillListRegistryState> {
  return readJsonFile<SkillListRegistryState>(skillListRegistryPath(dataRoot), defaultSkillListRegistry());
}

async function writeSkillListRegistry(dataRoot: string, registry: SkillListRegistryState): Promise<void> {
  await writeJsonFile(skillListRegistryPath(dataRoot), registry);
}

interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  warnings: string[];
}

function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const warnings: string[] = [];
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    warnings.push("SKILL.md missing YAML frontmatter; fallback metadata used");
    return {
      frontmatter: {},
      body: normalized,
      warnings
    };
  }

  const frontmatterRaw = match[1] ?? "";
  let parsed: unknown = {};
  try {
    parsed = yaml.load(frontmatterRaw);
  } catch {
    warnings.push("SKILL.md frontmatter parse failed; fallback metadata used");
    parsed = {};
  }
  const body = normalized.slice(match[0].length);
  return {
    frontmatter: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
    body,
    warnings
  };
}

function inferSourceType(skillRootPath: string): "opencode" | "codex" | "local" {
  const normalized = skillRootPath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.config/opencode/skills/")) {
    return "opencode";
  }
  if (normalized.includes("/.codex/skills/")) {
    return "codex";
  }
  return "local";
}

function extractDescriptionFromBody(body: string): string {
  const cleaned = body
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .find((part) => !part.startsWith("#"));
  if (!cleaned) {
    return "Imported skill";
  }
  const flattened = cleaned.replace(/\s+/g, " ").trim();
  return flattened.length > 240 ? `${flattened.slice(0, 237)}...` : flattened;
}

function buildStandardSkillMarkdown(input: {
  name: string;
  description: string;
  license: string;
  compatibility: string;
  body: string;
}): string {
  const frontmatter = yaml
    .dump(
      {
        name: input.name,
        description: input.description,
        license: input.license,
        compatibility: input.compatibility
      },
      { lineWidth: -1 }
    )
    .trimEnd();

  const normalizedBody = input.body.replace(/^\s*\r?\n/, "").trimEnd();
  if (!normalizedBody) {
    return `---\n${frontmatter}\n---\n`;
  }
  return `---\n${frontmatter}\n---\n${normalizedBody}\n`;
}

async function collectSkillMarkdownFilesFromDirectory(rootDir: string, recursive: boolean): Promise<string[]> {
  const discovered: string[] = [];
  if (!recursive) {
    const direct = path.join(rootDir, SKILL_FILE);
    try {
      const stat = await fs.stat(direct);
      if (stat.isFile()) {
        discovered.push(direct);
      }
    } catch {
      // noop
    }
    return discovered;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase() === SKILL_FILE.toLowerCase()) {
        discovered.push(absolute);
      }
    }
  }

  return discovered;
}

async function collectSkillMarkdownFiles(source: string, recursive: boolean): Promise<string[]> {
  const absolute = path.resolve(source);
  let stat: Stats;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new SkillStoreError(`source path not found: ${absolute}`, "IMPORT_SOURCE_NOT_FOUND");
  }

  if (stat.isFile()) {
    if (path.basename(absolute).toLowerCase() !== SKILL_FILE.toLowerCase()) {
      throw new SkillStoreError(`source file must be ${SKILL_FILE}: ${absolute}`, "INVALID_SOURCE_PATH");
    }
    return [absolute];
  }

  if (!stat.isDirectory()) {
    throw new SkillStoreError(`source path must be file or directory: ${absolute}`, "INVALID_SOURCE_PATH");
  }

  const files = await collectSkillMarkdownFilesFromDirectory(absolute, recursive);
  if (files.length === 0) {
    throw new SkillStoreError(`no ${SKILL_FILE} found under: ${absolute}`, "INVALID_SOURCE_PATH");
  }
  return files;
}

export async function listSkills(dataRoot: string): Promise<SkillDefinition[]> {
  const registry = await readSkillRegistry(dataRoot);
  return [...registry.skills].sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export async function importSkills(
  dataRoot: string,
  input: { sources: string[]; recursive?: boolean }
): Promise<SkillImportResult> {
  const recursive = input.recursive ?? true;
  const sources = input.sources.map((item) => item.trim()).filter((item) => item.length > 0);
  if (sources.length === 0) {
    throw new SkillStoreError("sources are required", "INVALID_SOURCE_PATH");
  }

  const registry = await readSkillRegistry(dataRoot);
  const byId = new Map(registry.skills.map((item) => [item.skillId, item]));
  const allWarnings: string[] = [];
  const markdownFiles = new Set<string>();

  for (const source of sources) {
    const files = await collectSkillMarkdownFiles(source, recursive);
    for (const file of files) {
      markdownFiles.add(path.resolve(file));
    }
  }

  const imported: SkillImportItem[] = [];
  const packageRoot = skillPackagesRoot(dataRoot);
  await ensureDirectory(packageRoot);

  for (const skillFilePath of Array.from(markdownFiles).sort((a, b) => a.localeCompare(b))) {
    const skillRootPath = path.dirname(skillFilePath);
    const raw = await fs.readFile(skillFilePath, "utf8");
    const parsed = parseSkillMarkdown(raw);
    const warnings = [...parsed.warnings];

    const frontName = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
    const frontDescription =
      typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";
    const frontLicense = typeof parsed.frontmatter.license === "string" ? parsed.frontmatter.license.trim() : "";
    const frontCompatibility =
      typeof parsed.frontmatter.compatibility === "string" ? parsed.frontmatter.compatibility.trim() : "";

    const name = frontName || path.basename(skillRootPath);
    if (!frontName) {
      warnings.push("frontmatter.name missing; fallback to folder name");
    }

    const description = frontDescription || extractDescriptionFromBody(parsed.body);
    if (!frontDescription) {
      warnings.push("frontmatter.description missing; fallback to first body paragraph");
    }

    const license = frontLicense || "UNSPECIFIED";
    if (!frontLicense) {
      warnings.push("frontmatter.license missing; fallback to UNSPECIFIED");
    }

    const sourceType = inferSourceType(skillRootPath);
    const compatibility = frontCompatibility || sourceType;
    if (!frontCompatibility) {
      warnings.push(`frontmatter.compatibility missing; inferred as ${sourceType}`);
    }

    const skillId = normalizeSkillId(name);
    const existing = byId.get(skillId);
    const action: "created" | "updated" = existing ? "updated" : "created";

    const standardizedSkillMd = buildStandardSkillMarkdown({
      name,
      description,
      license,
      compatibility,
      body: parsed.body
    });

    const targetDir = path.join(packageRoot, skillId);
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.cp(skillRootPath, targetDir, { recursive: true, force: true });
    await fs.writeFile(path.join(targetDir, SKILL_FILE), standardizedSkillMd, "utf8");

    const now = new Date().toISOString();
    const skill: SkillDefinition = {
      schemaVersion: "1.0",
      skillId,
      name,
      description,
      license,
      compatibility,
      sourceType,
      sourcePath: skillRootPath,
      packagePath: path.relative(skillsRoot(dataRoot), targetDir).replace(/\\/g, "/"),
      entryFile: SKILL_FILE,
      warnings: warnings.length > 0 ? warnings : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    if (existing && existing.sourcePath !== skillRootPath) {
      warnings.push(`skill_id '${skillId}' overridden by source: ${skillRootPath}`);
    }

    byId.set(skillId, skill);
    imported.push({ skill, action, warnings });
    allWarnings.push(...warnings.map((item) => `${skillId}: ${item}`));
  }

  registry.skills = Array.from(byId.values()).sort((a, b) => a.skillId.localeCompare(b.skillId));
  registry.updatedAt = new Date().toISOString();
  await writeSkillRegistry(dataRoot, registry);

  return {
    imported,
    warnings: allWarnings
  };
}

export async function deleteSkill(dataRoot: string, skillIdRaw: string): Promise<SkillDefinition> {
  const skillId = normalizeSkillId(skillIdRaw);
  const registry = await readSkillRegistry(dataRoot);
  const index = registry.skills.findIndex((item) => item.skillId === skillId);
  if (index < 0) {
    throw new SkillStoreError(`skill '${skillId}' not found`, "SKILL_NOT_FOUND");
  }

  const [removed] = registry.skills.splice(index, 1);
  registry.updatedAt = new Date().toISOString();
  await writeSkillRegistry(dataRoot, registry);

  const targetDir = path.join(skillPackagesRoot(dataRoot), skillId);
  await fs.rm(targetDir, { recursive: true, force: true });

  const listRegistry = await readSkillListRegistry(dataRoot);
  let listTouched = false;
  for (const list of listRegistry.lists) {
    const next = list.skillIds.filter((item) => item !== skillId);
    if (next.length !== list.skillIds.length) {
      list.skillIds = next;
      list.updatedAt = new Date().toISOString();
      listTouched = true;
    }
  }
  if (listTouched) {
    listRegistry.updatedAt = new Date().toISOString();
    await writeSkillListRegistry(dataRoot, listRegistry);
  }

  return removed;
}

function ensureReferencedSkillsExist(registry: SkillRegistryState, skillIds: string[]): void {
  const available = new Set(registry.skills.map((item) => item.skillId));
  const invalid = skillIds.filter((item) => !available.has(item));
  if (invalid.length > 0) {
    throw new SkillStoreError(`unknown skill ids: ${invalid.join(", ")}`, "INVALID_SKILL_REFERENCE");
  }
}

export async function listSkillLists(dataRoot: string): Promise<SkillListDefinition[]> {
  const registry = await readSkillListRegistry(dataRoot);
  return [...registry.lists].sort((a, b) => a.listId.localeCompare(b.listId));
}

export async function createSkillList(
  dataRoot: string,
  input: {
    listId: string;
    displayName?: string;
    description?: string;
    includeAll?: boolean;
    skillIds?: string[];
  }
): Promise<SkillListDefinition> {
  const skillRegistry = await readSkillRegistry(dataRoot);
  const listRegistry = await readSkillListRegistry(dataRoot);
  const listId = normalizeListId(input.listId);
  if (listRegistry.lists.some((item) => item.listId === listId)) {
    throw new SkillStoreError(`skill list '${listId}' already exists`, "SKILL_LIST_EXISTS");
  }

  const skillIds = normalizeSkillIds(input.skillIds);
  ensureReferencedSkillsExist(skillRegistry, skillIds);

  const now = new Date().toISOString();
  const list: SkillListDefinition = {
    schemaVersion: "1.0",
    listId,
    displayName: input.displayName?.trim() || listId,
    description: input.description?.trim() || undefined,
    includeAll: input.includeAll ?? false,
    skillIds,
    createdAt: now,
    updatedAt: now
  };

  listRegistry.lists.push(list);
  listRegistry.updatedAt = now;
  listRegistry.lists.sort((a, b) => a.listId.localeCompare(b.listId));
  await writeSkillListRegistry(dataRoot, listRegistry);
  return list;
}

export async function patchSkillList(
  dataRoot: string,
  listIdRaw: string,
  patch: {
    displayName?: string;
    description?: string | null;
    includeAll?: boolean;
    skillIds?: string[];
  }
): Promise<SkillListDefinition> {
  const listId = normalizeListId(listIdRaw);
  const skillRegistry = await readSkillRegistry(dataRoot);
  const listRegistry = await readSkillListRegistry(dataRoot);
  const index = listRegistry.lists.findIndex((item) => item.listId === listId);
  if (index < 0) {
    throw new SkillStoreError(`skill list '${listId}' not found`, "SKILL_LIST_NOT_FOUND");
  }

  const existing = listRegistry.lists[index];
  const nextSkillIds = patch.skillIds === undefined ? existing.skillIds : normalizeSkillIds(patch.skillIds);
  ensureReferencedSkillsExist(skillRegistry, nextSkillIds);

  const next: SkillListDefinition = {
    ...existing,
    displayName: patch.displayName?.trim() || existing.displayName,
    description:
      patch.description === undefined
        ? existing.description
        : patch.description === null
          ? undefined
          : patch.description.trim() || undefined,
    includeAll: patch.includeAll ?? existing.includeAll,
    skillIds: nextSkillIds,
    updatedAt: new Date().toISOString()
  };

  listRegistry.lists[index] = next;
  listRegistry.updatedAt = next.updatedAt;
  await writeSkillListRegistry(dataRoot, listRegistry);
  return next;
}

export async function deleteSkillList(dataRoot: string, listIdRaw: string): Promise<SkillListDefinition> {
  const listId = normalizeListId(listIdRaw);
  const listRegistry = await readSkillListRegistry(dataRoot);
  const index = listRegistry.lists.findIndex((item) => item.listId === listId);
  if (index < 0) {
    throw new SkillStoreError(`skill list '${listId}' not found`, "SKILL_LIST_NOT_FOUND");
  }

  const [removed] = listRegistry.lists.splice(index, 1);
  listRegistry.updatedAt = new Date().toISOString();
  await writeSkillListRegistry(dataRoot, listRegistry);
  return removed;
}

export async function validateSkillListIds(dataRoot: string, ids: string[] | undefined): Promise<string[]> {
  if (!ids || ids.length === 0) {
    return [];
  }
  const normalized = normalizeSkillIds(ids);
  const listRegistry = await readSkillListRegistry(dataRoot);
  const available = new Set(listRegistry.lists.map((item) => item.listId));
  return normalized.filter((id) => !available.has(id));
}

export async function resolveSkillIdsForAgent(dataRoot: string, listIdsRaw: string[] | undefined): Promise<string[]> {
  const listIds = normalizeSkillIds(listIdsRaw);
  if (listIds.length === 0) {
    return [];
  }

  const [skills, lists] = await Promise.all([readSkillRegistry(dataRoot), readSkillListRegistry(dataRoot)]);
  const allSkillIds = skills.skills.map((item) => item.skillId);
  const listMap = new Map(lists.lists.map((item) => [item.listId, item]));

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const listId of listIds) {
    const list = listMap.get(listId);
    if (!list) {
      continue;
    }
    const merged = [...(list.includeAll ? allSkillIds : []), ...list.skillIds];
    for (const skillId of merged) {
      if (seen.has(skillId)) {
        continue;
      }
      seen.add(skillId);
      ordered.push(skillId);
    }
  }
  return ordered;
}

export async function resolveImportedSkillPromptSegments(
  dataRoot: string,
  skillIdsRaw: string[] | undefined
): Promise<SkillPromptSegmentResolveResult> {
  const requested = normalizeSkillIds(skillIdsRaw);
  if (requested.length === 0) {
    return {
      segments: [],
      resolvedSkillIds: [],
      missingSkillIds: [],
      warnings: []
    };
  }

  const registry = await readSkillRegistry(dataRoot);
  const byId = new Map(registry.skills.map((item) => [item.skillId, item]));
  const segments: string[] = [];
  const resolvedSkillIds: string[] = [];
  const missingSkillIds: string[] = [];
  const warnings: string[] = [];

  for (const skillId of requested) {
    const definition = byId.get(skillId);
    if (!definition) {
      missingSkillIds.push(skillId);
      warnings.push(`skill '${skillId}' is missing in registry`);
      continue;
    }

    const entryPath = path.join(skillsRoot(dataRoot), definition.packagePath, definition.entryFile || SKILL_FILE);
    let raw = "";
    try {
      raw = await fs.readFile(entryPath, "utf8");
    } catch {
      missingSkillIds.push(skillId);
      warnings.push(`skill '${skillId}' entry file missing: ${entryPath}`);
      continue;
    }
    const parsed = parseSkillMarkdown(raw);
    warnings.push(...parsed.warnings.map((item) => `${skillId}: ${item}`));

    const body = parsed.body.trim().length > 0 ? parsed.body.trim() : raw.trim();
    segments.push(
      [
        `## Imported Skill: ${definition.name} (${definition.skillId})`,
        definition.description ? `Description: ${definition.description}` : "",
        body
      ]
        .filter((item) => item.length > 0)
        .join("\n\n")
    );
    resolvedSkillIds.push(skillId);
  }

  return {
    segments,
    resolvedSkillIds,
    missingSkillIds,
    warnings
  };
}


