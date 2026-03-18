import type { createOrchestratorService } from "../services/orchestrator-service.js";
import type { createWorkflowOrchestratorService } from "../services/workflow-orchestrator-service.js";
import type { createProviderRegistry } from "../services/provider-runtime.js";

export interface AppRuntimeContext {
  dataRoot: string;
  orchestrator: ReturnType<typeof createOrchestratorService>;
  workflowOrchestrator: ReturnType<typeof createWorkflowOrchestratorService>;
  providerRegistry: ReturnType<typeof createProviderRegistry>;
}
