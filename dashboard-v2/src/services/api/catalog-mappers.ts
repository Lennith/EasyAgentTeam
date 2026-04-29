import type { SkillDefinition, SkillListDefinition } from "@/types/catalog";

export function mapSkillDefinition(raw: Record<string, unknown>): SkillDefinition {
  return {
    schemaVersion: (raw.schemaVersion ?? raw.schema_version ?? "1.0") as "1.0",
    skillId: (raw.skillId ?? raw.skill_id) as string,
    name: raw.name as string,
    description: raw.description as string,
    license: raw.license as string,
    compatibility: raw.compatibility as string,
    sourceType: (raw.sourceType ?? raw.source_type) as "opencode" | "codex" | "local",
    sourcePath: (raw.sourcePath ?? raw.source_path) as string,
    packagePath: (raw.packagePath ?? raw.package_path) as string,
    entryFile: (raw.entryFile ?? raw.entry_file ?? "SKILL.md") as string,
    warnings: raw.warnings as string[] | undefined,
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string
  };
}

export function mapSkillListDefinition(raw: Record<string, unknown>): SkillListDefinition {
  return {
    schemaVersion: (raw.schemaVersion ?? raw.schema_version ?? "1.0") as "1.0",
    listId: (raw.listId ?? raw.list_id) as string,
    displayName: (raw.displayName ?? raw.display_name) as string,
    description: raw.description as string | undefined,
    includeAll: (raw.includeAll ?? raw.include_all ?? false) as boolean,
    skillIds: (raw.skillIds ?? raw.skill_ids ?? []) as string[],
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string
  };
}
