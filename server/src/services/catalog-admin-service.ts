import { createAgent, deleteAgent, listAgents, patchAgent } from "../data/repository/catalog/agent-repository.js";
import {
  createCustomAgentTemplate,
  deleteCustomAgentTemplate,
  listCustomAgentTemplates,
  patchCustomAgentTemplate
} from "../data/repository/catalog/agent-template-repository.js";
import {
  createSkillList,
  deleteSkill,
  deleteSkillList,
  importSkills,
  listSkillLists,
  listSkills,
  patchSkillList,
  validateSkillListIds
} from "../data/repository/catalog/skill-repository.js";
import { createTeam, deleteTeam, getTeam, listTeams, updateTeam } from "../data/repository/catalog/team-repository.js";

export async function listCatalogAgents(dataRoot: string) {
  return listAgents(dataRoot);
}

export async function createCatalogAgent(dataRoot: string, input: Parameters<typeof createAgent>[1]) {
  return createAgent(dataRoot, input);
}

export async function patchCatalogAgent(dataRoot: string, agentId: string, patch: Parameters<typeof patchAgent>[2]) {
  return patchAgent(dataRoot, agentId, patch);
}

export async function deleteCatalogAgent(dataRoot: string, agentId: string) {
  return deleteAgent(dataRoot, agentId);
}

export async function listCatalogAgentTemplates(dataRoot: string) {
  return listCustomAgentTemplates(dataRoot);
}

export async function createCatalogAgentTemplate(
  dataRoot: string,
  input: Parameters<typeof createCustomAgentTemplate>[1]
) {
  return createCustomAgentTemplate(dataRoot, input);
}

export async function patchCatalogAgentTemplate(
  dataRoot: string,
  templateId: string,
  patch: Parameters<typeof patchCustomAgentTemplate>[2]
) {
  return patchCustomAgentTemplate(dataRoot, templateId, patch);
}

export async function deleteCatalogAgentTemplate(dataRoot: string, templateId: string) {
  return deleteCustomAgentTemplate(dataRoot, templateId);
}

export async function listCatalogTeams(dataRoot: string) {
  return listTeams(dataRoot);
}

export async function readCatalogTeam(dataRoot: string, teamId: string) {
  return getTeam(dataRoot, teamId);
}

export async function createCatalogTeam(dataRoot: string, input: Parameters<typeof createTeam>[1]) {
  return createTeam(dataRoot, input);
}

export async function updateCatalogTeam(dataRoot: string, teamId: string, input: Parameters<typeof updateTeam>[2]) {
  return updateTeam(dataRoot, teamId, input);
}

export async function deleteCatalogTeam(dataRoot: string, teamId: string) {
  return deleteTeam(dataRoot, teamId);
}

export async function listCatalogSkills(dataRoot: string) {
  return listSkills(dataRoot);
}

export async function importCatalogSkills(dataRoot: string, input: Parameters<typeof importSkills>[1]) {
  return importSkills(dataRoot, input);
}

export async function deleteCatalogSkill(dataRoot: string, skillId: string) {
  return deleteSkill(dataRoot, skillId);
}

export async function listCatalogSkillLists(dataRoot: string) {
  return listSkillLists(dataRoot);
}

export async function createCatalogSkillList(dataRoot: string, input: Parameters<typeof createSkillList>[1]) {
  return createSkillList(dataRoot, input);
}

export async function patchCatalogSkillList(
  dataRoot: string,
  listId: string,
  patch: Parameters<typeof patchSkillList>[2]
) {
  return patchSkillList(dataRoot, listId, patch);
}

export async function deleteCatalogSkillList(dataRoot: string, listId: string) {
  return deleteSkillList(dataRoot, listId);
}

export async function validateCatalogSkillListIds(dataRoot: string, ids: string[] | undefined) {
  return validateSkillListIds(dataRoot, ids);
}
