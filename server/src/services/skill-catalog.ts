import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { ProviderId } from "@autodev/agent-library";

export interface SkillManifestEntry {
  id: string;
  name: string;
  version?: string;
  description?: string;
  entry: string;
  enabled?: boolean;
  required?: boolean;
  providers?: ProviderId[];
  contexts?: string[];
}

export interface SkillManifestFile {
  skills: SkillManifestEntry[];
}

export interface ResolveSkillPromptInput {
  manifestPath?: string;
  providerId: ProviderId;
  contextKind?: string;
  requestedSkillIds?: string[];
  requiredSkillIds?: string[];
}

export interface ResolveSkillPromptResult {
  segments: string[];
  resolvedSkillIds: string[];
  missingRequiredSkillIds: string[];
  warnings: string[];
}

function normalizeSkillId(raw: string): string {
  return raw.trim();
}

function normalizeSkillIds(raw?: string[]): Set<string> {
  if (!raw || raw.length === 0) {
    return new Set<string>();
  }
  return new Set(raw.map((item) => normalizeSkillId(item)).filter((item) => item.length > 0));
}

function parseManifest(content: string, manifestPath: string): SkillManifestFile {
  const ext = path.extname(manifestPath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    const parsed = yaml.load(content) as SkillManifestFile | null;
    return parsed && Array.isArray(parsed.skills) ? parsed : { skills: [] };
  }
  const parsed = JSON.parse(content) as SkillManifestFile;
  return parsed && Array.isArray(parsed.skills) ? parsed : { skills: [] };
}

function shouldIncludeSkill(
  skill: SkillManifestEntry,
  input: ResolveSkillPromptInput,
  requested: Set<string>
): boolean {
  if (skill.enabled === false) {
    return false;
  }
  if (requested.size > 0 && !requested.has(skill.id)) {
    return false;
  }
  if (skill.providers && skill.providers.length > 0 && !skill.providers.includes(input.providerId)) {
    return false;
  }
  if (input.contextKind && skill.contexts && skill.contexts.length > 0 && !skill.contexts.includes(input.contextKind)) {
    return false;
  }
  return true;
}

function renderSkillSegment(skill: SkillManifestEntry, content: string): string {
  return [
    `## Skill: ${skill.name} (${skill.id})`,
    skill.description ? `Description: ${skill.description}` : "",
    content.trim()
  ]
    .filter((item) => item.length > 0)
    .join("\n\n");
}

export function resolveSkillPromptSegments(input: ResolveSkillPromptInput): ResolveSkillPromptResult {
  if (!input.manifestPath || input.manifestPath.trim().length === 0) {
    return {
      segments: [],
      resolvedSkillIds: [],
      missingRequiredSkillIds: [],
      warnings: []
    };
  }

  const manifestPath = path.resolve(input.manifestPath);
  if (!fs.existsSync(manifestPath)) {
    return {
      segments: [],
      resolvedSkillIds: [],
      missingRequiredSkillIds: [],
      warnings: [`skill manifest not found: ${manifestPath}`]
    };
  }

  const requestedIds = normalizeSkillIds(input.requestedSkillIds);
  const requiredIds = normalizeSkillIds(input.requiredSkillIds);
  const manifestDir = path.dirname(manifestPath);
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const manifest = parseManifest(raw, manifestPath);
  const selected = manifest.skills.filter((skill) => shouldIncludeSkill(skill, input, requestedIds));
  const segments: string[] = [];
  const resolvedSkillIds: string[] = [];
  const warnings: string[] = [];
  const missingRequired = new Set<string>(requiredIds);

  for (const skill of selected) {
    const entryPath = path.resolve(manifestDir, skill.entry);
    if (!fs.existsSync(entryPath)) {
      warnings.push(`skill entry missing: ${skill.id} -> ${entryPath}`);
      continue;
    }
    const content = fs.readFileSync(entryPath, "utf-8");
    const segment = renderSkillSegment(skill, content);
    segments.push(segment);
    resolvedSkillIds.push(skill.id);
    missingRequired.delete(skill.id);
  }

  for (const skill of selected) {
    if (skill.required) {
      missingRequired.add(skill.id);
    }
  }
  for (const resolvedId of resolvedSkillIds) {
    missingRequired.delete(resolvedId);
  }

  return {
    segments,
    resolvedSkillIds,
    missingRequiredSkillIds: Array.from(missingRequired),
    warnings
  };
}
