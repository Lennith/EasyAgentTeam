import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowTemplateRecord
} from "../../domain/models.js";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  deleteWorkflowRun,
  deleteWorkflowTemplate,
  getWorkflowRun,
  getWorkflowTemplate,
  listWorkflowRuns,
  listWorkflowTemplates,
  patchWorkflowRun,
  patchWorkflowTemplate
} from "../workflow-store.js";
import {
  ensureWorkflowRunRuntime,
  readWorkflowRunTaskRuntimeState,
  writeWorkflowRunTaskRuntimeState
} from "../workflow-run-store.js";

export type CreateWorkflowTemplateInput = Parameters<typeof createWorkflowTemplate>[1];
export type PatchWorkflowTemplateInput = Parameters<typeof patchWorkflowTemplate>[2];
export type CreateWorkflowRunInput = Parameters<typeof createWorkflowRun>[1];
export type PatchWorkflowRunInput = Parameters<typeof patchWorkflowRun>[2];

export interface WorkflowRunRepository {
  listTemplates(): Promise<WorkflowTemplateRecord[]>;
  getTemplate(templateId: string): Promise<WorkflowTemplateRecord | null>;
  createTemplate(input: CreateWorkflowTemplateInput): Promise<WorkflowTemplateRecord>;
  patchTemplate(templateId: string, patch: PatchWorkflowTemplateInput): Promise<WorkflowTemplateRecord>;
  deleteTemplate(templateId: string): Promise<{ templateId: string; removedAt: string }>;
  listRuns(): Promise<WorkflowRunRecord[]>;
  getRun(runId: string): Promise<WorkflowRunRecord | null>;
  createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord>;
  patchRun(runId: string, patch: PatchWorkflowRunInput): Promise<WorkflowRunRecord>;
  deleteRun(runId: string): Promise<{ runId: string; removedAt: string }>;
  ensureRuntime(runId: string, initialRuntime?: WorkflowRunRuntimeState): Promise<void>;
  readRuntime(runId: string): Promise<WorkflowRunRuntimeState>;
  writeRuntime(runId: string, runtime: WorkflowRunRuntimeState): Promise<void>;
}

class DefaultWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly dataRoot: string) {}

  listTemplates(): Promise<WorkflowTemplateRecord[]> {
    return listWorkflowTemplates(this.dataRoot);
  }

  getTemplate(templateId: string): Promise<WorkflowTemplateRecord | null> {
    return getWorkflowTemplate(this.dataRoot, templateId);
  }

  createTemplate(input: CreateWorkflowTemplateInput): Promise<WorkflowTemplateRecord> {
    return createWorkflowTemplate(this.dataRoot, input);
  }

  patchTemplate(templateId: string, patch: PatchWorkflowTemplateInput): Promise<WorkflowTemplateRecord> {
    return patchWorkflowTemplate(this.dataRoot, templateId, patch);
  }

  deleteTemplate(templateId: string): Promise<{ templateId: string; removedAt: string }> {
    return deleteWorkflowTemplate(this.dataRoot, templateId);
  }

  listRuns(): Promise<WorkflowRunRecord[]> {
    return listWorkflowRuns(this.dataRoot);
  }

  getRun(runId: string): Promise<WorkflowRunRecord | null> {
    return getWorkflowRun(this.dataRoot, runId);
  }

  createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
    return createWorkflowRun(this.dataRoot, input);
  }

  patchRun(runId: string, patch: PatchWorkflowRunInput): Promise<WorkflowRunRecord> {
    return patchWorkflowRun(this.dataRoot, runId, patch);
  }

  deleteRun(runId: string): Promise<{ runId: string; removedAt: string }> {
    return deleteWorkflowRun(this.dataRoot, runId);
  }

  async ensureRuntime(runId: string, initialRuntime?: WorkflowRunRuntimeState): Promise<void> {
    await ensureWorkflowRunRuntime(this.dataRoot, runId, initialRuntime);
  }

  readRuntime(runId: string): Promise<WorkflowRunRuntimeState> {
    return readWorkflowRunTaskRuntimeState(this.dataRoot, runId);
  }

  writeRuntime(runId: string, runtime: WorkflowRunRuntimeState): Promise<void> {
    return writeWorkflowRunTaskRuntimeState(this.dataRoot, runId, runtime);
  }
}

export function createWorkflowRunRepository(dataRoot: string): WorkflowRunRepository {
  return new DefaultWorkflowRunRepository(dataRoot);
}
