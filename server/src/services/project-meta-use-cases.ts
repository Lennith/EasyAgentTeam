import { appendEvent } from "../data/event-store.js";
import { listAgents } from "../data/agent-store.js";
import { getProjectPaths } from "../data/project-store.js";
import { getProjectRepositoryBundle } from "../data/repository/project-repository-bundle.js";
import { ensureAgentWorkspaces } from "./agent-workspace-service.js";
import { buildOrchestratorAgentCatalog } from "./orchestrator/shared/index.js";
import { ensureProjectAgentScripts } from "./project-agent-script-service.js";
import { applyProjectTemplate } from "./project-template-service.js";
import type { ProjectRecord } from "../domain/models.js";

export async function createProjectWithAudit(
  dataRoot: string,
  input: Parameters<ReturnType<typeof getProjectRepositoryBundle>["projectRuntime"]["createProject"]>[0]
): Promise<ProjectRecord> {
  const repositories = getProjectRepositoryBundle(dataRoot);
  const projectPaths = getProjectPaths(dataRoot, input.projectId);
  let created!: Awaited<ReturnType<typeof repositories.projectRuntime.createProject>>;
  await repositories.unitOfWork.run([projectPaths.projectRootDir], async () => {
    created = await repositories.projectRuntime.createProject(input);
    await appendEvent(created.paths, {
      projectId: created.project.projectId,
      eventType: "PROJECT_CREATED",
      source: "manager",
      payload: { name: created.project.name, workspacePath: created.project.workspacePath }
    });
  });

  const templateApplyResult = await applyProjectTemplate(created.project);
  const scriptBootstrap = await ensureProjectAgentScripts(created.project);
  const agentList = await listAgents(dataRoot);
  const agentCatalog = buildOrchestratorAgentCatalog(agentList);
  const agentWorkspaceBootstrap = await ensureAgentWorkspaces(
    created.project,
    agentCatalog.rolePromptMap,
    undefined,
    agentCatalog.roleSummaryMap
  );

  if (templateApplyResult.applied) {
    await appendEvent(created.paths, {
      projectId: created.project.projectId,
      eventType: "PROJECT_TEMPLATE_APPLIED",
      source: "manager",
      payload: {
        templateId: templateApplyResult.templateId,
        createdFiles: templateApplyResult.createdFiles,
        skippedFiles: templateApplyResult.skippedFiles
      }
    });
  }
  await appendEvent(created.paths, {
    projectId: created.project.projectId,
    eventType: "PROJECT_AGENT_SCRIPT_BOOTSTRAPPED",
    source: "manager",
    payload: { createdFiles: scriptBootstrap.createdFiles, skippedFiles: scriptBootstrap.skippedFiles }
  });
  await appendEvent(created.paths, {
    projectId: created.project.projectId,
    eventType: "PROJECT_AGENT_WORKSPACES_BOOTSTRAPPED",
    source: "manager",
    payload: {
      createdFiles: agentWorkspaceBootstrap.createdFiles,
      skippedFiles: agentWorkspaceBootstrap.skippedFiles
    }
  });
  return created.project;
}
