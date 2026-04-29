import { projectCoreApi } from "./project-core-api";
import { projectEventsApi } from "./project-events-api";
import { projectLockApi } from "./project-lock-api";
import { projectMessageApi } from "./project-message-api";
import { projectOrchestratorApi } from "./project-orchestrator-api";
import { projectRoutingApi } from "./project-routing-api";
import { projectSessionApi } from "./project-session-api";
import { projectTaskApi } from "./project-task-api";
export { projectTemplateApi } from "./project-template-api";

export const projectApi = {
  ...projectCoreApi,
  ...projectEventsApi,
  ...projectSessionApi,
  ...projectTaskApi,
  ...projectLockApi,
  ...projectRoutingApi,
  ...projectMessageApi,
  ...projectOrchestratorApi
};
