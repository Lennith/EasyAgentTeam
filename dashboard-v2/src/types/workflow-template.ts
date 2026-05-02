export interface WorkflowTemplateTaskRecord {
  taskId: string;
  title: string;
  ownerRole: string;
  parentTaskId?: string;
  dependencies?: string[];
  writeSet?: string[];
  acceptance?: string[];
  artifacts?: string[];
}

export interface WorkflowTemplateRecord {
  schemaVersion: "1.0";
  templateId: string;
  name: string;
  description?: string;
  tasks: WorkflowTemplateTaskRecord[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  defaultVariables?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
