import type { createOrchestratorService, createWorkflowOrchestratorService } from "../services/orchestrator/index.js";
import type { createProviderRegistry } from "../services/provider-runtime.js";

export interface AppRuntimeContext {
  dataRoot: string;
  orchestrator: ReturnType<typeof createOrchestratorService>;
  workflowOrchestrator: ReturnType<typeof createWorkflowOrchestratorService>;
  providerRegistry: ReturnType<typeof createProviderRegistry>;
}
