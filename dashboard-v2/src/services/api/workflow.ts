import { workflowMessageApi } from "./workflow-message-api";
import { workflowOrchestratorApi } from "./workflow-orchestrator-api";
import { workflowRunApi } from "./workflow-run-api";
import { workflowSessionApi } from "./workflow-session-api";
import { workflowTaskApi } from "./workflow-task-api";
import { workflowTemplateApi } from "./workflow-template-api";
import { triggerApi } from "./trigger-api";

export const workflowApi = {
  ...workflowTemplateApi,
  ...workflowRunApi,
  ...workflowTaskApi,
  ...workflowSessionApi,
  ...workflowMessageApi,
  ...workflowOrchestratorApi,
  ...triggerApi
};
