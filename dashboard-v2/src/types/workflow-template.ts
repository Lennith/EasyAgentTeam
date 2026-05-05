import type { WorkflowTemplateRecordContract } from "@autodev/agent-library";

export type WorkflowTemplateRecord = WorkflowTemplateRecordContract;
export type WorkflowTemplateTaskRecord = WorkflowTemplateRecord["tasks"][number];
