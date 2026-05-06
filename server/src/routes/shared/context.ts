import type {
  createOrchestratorService,
  createWorkflowOrchestratorService
} from "../../services/orchestrator/index.js";
import type { ProviderRegistry } from "../../services/provider-runtime.js";
import type { createTriggerRuntimeService } from "../../services/trigger/index.js";

export interface AppRuntimeContext {
  dataRoot: string;
  orchestrator: ReturnType<typeof createOrchestratorService>;
  workflowOrchestrator: ReturnType<typeof createWorkflowOrchestratorService>;
  triggerRuntime?: ReturnType<typeof createTriggerRuntimeService>;
  providerRegistry: ProviderRegistry;
}
