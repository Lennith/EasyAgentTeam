import { listAgents } from "../data/repository/catalog/agent-repository.js";
import { listWorkflowRunEvents } from "../data/repository/workflow/runtime-repository.js";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  deleteWorkflowRun,
  deleteWorkflowTemplate,
  getWorkflowRun,
  getWorkflowTemplate,
  listWorkflowRuns,
  listWorkflowTemplates,
  patchWorkflowTemplate
} from "../data/repository/workflow/run-repository.js";

export async function listWorkflowTemplatesForApi(dataRoot: string) {
  return listWorkflowTemplates(dataRoot);
}

export async function readWorkflowTemplateForApi(dataRoot: string, templateId: string) {
  return getWorkflowTemplate(dataRoot, templateId);
}

export async function createWorkflowTemplateForApi(
  dataRoot: string,
  input: Parameters<typeof createWorkflowTemplate>[1]
) {
  return createWorkflowTemplate(dataRoot, input);
}

export async function patchWorkflowTemplateForApi(
  dataRoot: string,
  templateId: string,
  patch: Parameters<typeof patchWorkflowTemplate>[2]
) {
  return patchWorkflowTemplate(dataRoot, templateId, patch);
}

export async function deleteWorkflowTemplateForApi(dataRoot: string, templateId: string) {
  return deleteWorkflowTemplate(dataRoot, templateId);
}

export async function listWorkflowRunsForApi(dataRoot: string) {
  return listWorkflowRuns(dataRoot);
}

export async function readWorkflowRunForApi(dataRoot: string, runId: string) {
  return getWorkflowRun(dataRoot, runId);
}

export async function createWorkflowRunForApi(dataRoot: string, input: Parameters<typeof createWorkflowRun>[1]) {
  return createWorkflowRun(dataRoot, input);
}

export async function deleteWorkflowRunForApi(dataRoot: string, runId: string) {
  return deleteWorkflowRun(dataRoot, runId);
}

export async function listWorkflowCatalogAgents(dataRoot: string) {
  return listAgents(dataRoot);
}

export async function listWorkflowEventsForApi(dataRoot: string, runId: string) {
  return listWorkflowRunEvents(dataRoot, runId);
}
