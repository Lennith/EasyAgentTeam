import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogAgentCreateRequestSchema,
  CatalogAgentPatchRequestSchema,
  CatalogAgentTemplateCreateRequestSchema,
  CatalogSkillImportRequestSchema,
  CatalogSkillListPatchRequestSchema,
  CatalogTeamCreateRequestSchema,
  ProjectCreateRequestSchema,
  ProjectDispatchRequestSchema,
  ProjectMessageSendRequestSchema,
  ProjectTaskActionRequestSchema,
  ProjectTaskPatchRequestSchema,
  RuntimeSettingsPatchRequestSchema,
  TeamToolInputPayloadSchema
} from "@autodev/agent-library";

test("project contract schemas accept current public payloads and reject invalid actions", () => {
  const taskAction = ProjectTaskActionRequestSchema.parse({
    action_type: "TASK_REPORT",
    from_agent: "dev",
    from_session_id: "session-1",
    payload: {
      results: [{ task_id: "task-1", outcome: "DONE", summary: "implemented" }]
    }
  });
  assert.equal(taskAction.actionType, "TASK_REPORT");
  const actionResults = taskAction.actionInput.results as Array<{ taskId?: string }>;
  assert.equal(actionResults[0]?.taskId, "task-1");

  assert.equal(ProjectTaskActionRequestSchema.safeParse({ action_type: "TASK_REPORT", payload: {} }).success, false);
  assert.equal(
    ProjectTaskActionRequestSchema.safeParse({ action_type: "TASK_CREATE", payload: { title: "" } }).success,
    false
  );

  const patch = ProjectTaskPatchRequestSchema.parse({
    owner_role: "qa",
    dependencies: ["task-a", "task-b"],
    priority: 2
  });
  assert.equal(patch.ownerRole, "qa");
  assert.deepEqual(patch.dependencies, ["task-a", "task-b"]);

  const message = ProjectMessageSendRequestSchema.parse({
    from_agent: "manager",
    to: { agent: "dev" },
    content: "please continue",
    message_type: "MANAGER_MESSAGE"
  });
  assert.equal(message.toRole, "dev");

  assert.equal(ProjectDispatchRequestSchema.parse({ role: "dev", force: true }).role, "dev");
});

test("catalog and runtime setting schemas normalize request payloads", () => {
  const project = ProjectCreateRequestSchema.parse({
    projectId: "project-1",
    name: "Project",
    workspacePath: "C:/work/project"
  });
  assert.equal(project.projectId, "project-1");
  assert.equal(project.workspacePath, "C:/work/project");

  const template = CatalogAgentTemplateCreateRequestSchema.parse({
    templateId: "tpl-1",
    prompt: "Template prompt"
  });
  assert.equal(template.templateId, "tpl-1");

  const agent = CatalogAgentCreateRequestSchema.parse({
    agentId: "dev",
    display_name: "Developer",
    prompt: "Build",
    providerId: "dpagent",
    skill_list: ["base", "base", "repo"]
  });
  assert.equal(agent.agentId, "dev");
  assert.equal(agent.providerId, "dpagent");
  assert.deepEqual(agent.skillList, ["base", "repo"]);

  const team = CatalogTeamCreateRequestSchema.parse({
    teamId: "team-1",
    name: "Team",
    agent_ids: ["pm", "dev"],
    agent_model_configs: {
      dev: { provider_id: "dpagent", model: "dpagent-default" }
    }
  });
  assert.equal(team.agentModelConfigs?.dev?.provider_id, "dpagent");

  assert.equal(
    CatalogAgentCreateRequestSchema.safeParse({ agent_id: "x", prompt: "p", provider_id: "trae" }).success,
    false
  );
  assert.deepEqual(CatalogAgentPatchRequestSchema.parse({ skill_list: null }).skillList, []);
  assert.deepEqual(CatalogSkillListPatchRequestSchema.parse({ skill_ids: null }).skillIds, []);
  assert.equal(CatalogSkillImportRequestSchema.parse({ source: "C:/skills" }).sources[0], "C:/skills");

  const settings = RuntimeSettingsPatchRequestSchema.parse({
    security: { remote_password: null },
    providers: {
      dpagent: { cli_command: "dpagent" },
      minimax: { max_steps: 10 }
    }
  });
  assert.equal(settings.security?.remotePassword, null);
  assert.equal(settings.providers?.dpagent?.cliCommand, "dpagent");
  assert.equal(settings.providers?.minimax?.maxSteps, 10);
});

test("TeamTool input schema validates concrete tool payloads", () => {
  assert.equal(
    TeamToolInputPayloadSchema.safeParse({
      tool: "task_create_assign",
      input: {
        task_id: "task-1",
        title: "Implement",
        to_role: "dev",
        parent_task_id: "root"
      }
    }).success,
    true
  );
  assert.equal(
    TeamToolInputPayloadSchema.safeParse({
      tool: "task_report_done",
      input: {
        task_id: "",
        task_report: ""
      }
    }).success,
    false
  );
});
