import { MODULE_NAMES } from "../constants.mjs";
import { AgentWorkspaceError } from "../errors.mjs";
import { requestJson } from "../utils/http-client.mjs";
import { ensureValidated } from "./module-helpers.mjs";

export async function validateSkillsImportModule(context) {
  ensureValidated(context);
  const sources = context.computed.resolvedSkillSources ?? [];
  if (sources.length === 0) {
    throw new AgentWorkspaceError("skills import requires at least one resolved source", "SKILLS_SOURCE_EMPTY");
  }
  return {
    module: MODULE_NAMES.SKILLS_IMPORT,
    warnings: []
  };
}

export async function executeSkillsImportModule(context) {
  ensureValidated(context);
  const payload = {
    sources: context.computed.resolvedSkillSources,
    recursive: true
  };
  const response = await requestJson(context.baseUrl, "POST", "/api/skills/import", payload, [200]);
  const imported = Array.isArray(response?.imported) ? response.imported : [];
  const created = [];
  const updated = [];
  for (const item of imported) {
    const skillId = String(item?.skill?.skillId ?? "").trim();
    const action = String(item?.action ?? "").trim();
    if (!skillId) {
      continue;
    }
    if (action === "created") {
      created.push(skillId);
    } else if (action === "updated") {
      updated.push(skillId);
    }
  }
  if (updated.length > 0) {
    throw new AgentWorkspaceError("skill import attempted to update existing skill ids", "SKILL_CONFLICT_RUNTIME", {
      updated
    });
  }
  context.execution.created.skills.push(...created);
  return {
    module: MODULE_NAMES.SKILLS_IMPORT,
    created
  };
}

