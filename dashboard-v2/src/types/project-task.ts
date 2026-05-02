export type TaskState = "PLANNED" | "READY" | "DISPATCHED" | "IN_PROGRESS" | "BLOCKED_DEP" | "DONE" | "CANCELED";

export type TaskKind = "PROJECT_ROOT" | "USER_ROOT" | "EXECUTION";

export interface TaskTreeNode {
  task_id: string;
  task_detail_id?: string;
  task_kind: TaskKind;
  parent_task_id: string | null;
  root_task_id: string | null;
  title: string;
  state: TaskState;
  creator_role: string | null;
  creator_session_id: string | null;
  owner_role: string;
  owner_session: string | null;
  priority: number;
  dependencies: string[];
  write_set: string[];
  acceptance: string[];
  artifacts: string[];
  alert: string | null;
  granted_at: string | null;
  closed_at: string | null;
  last_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskLifecycleEvent {
  event_type: string;
  source: string;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface TaskDetail {
  project_id: string;
  task_id: string;
  task_detail_id: string;
  task: TaskTreeNode;
  created_by: {
    role: string;
    session_id?: string;
  };
  create_parameters?: Record<string, unknown>;
  lifecycle: TaskLifecycleEvent[];
  stats: {
    lifecycle_event_count: number;
  };
}

export interface TaskTreeEdge {
  from_task_id: string;
  to_task_id: string;
  relation: "DEPENDS_ON" | "PARENT_OF" | "PARENT_CHILD";
  edge_type?: string;
  external?: boolean;
}

export interface TaskTreeResponse {
  project_id: string;
  generated_at: string;
  query: {
    focus_task_id?: string;
    max_descendant_depth?: number;
    include_external_dependencies?: boolean;
  };
  roots: string[];
  focus: TaskTreeNode | null;
  nodes: TaskTreeNode[];
  edges: TaskTreeEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    external_dependency_edge_count: number;
  };
}

export type TaskActionType =
  | "TASK_CREATE"
  | "TASK_UPDATE"
  | "TASK_ASSIGN"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED"
  | "TASK_REPORT";

export interface TaskActionRequest {
  action_type: TaskActionType;
  from_agent: string;
  from_session_id?: string | null;
  to_role?: string;
  to_session_id?: string | null;
  payload: {
    task_id?: string;
    title?: string;
    parent_task_id?: string;
    owner_role?: string;
    dependencies?: string[];
    acceptance?: string[];
    write_set?: string[];
    state?: string;
    content?: string;
    thread_id?: string;
    round?: number;
    summary?: string;
    artifacts?: string[];
    alert?: string;
  };
}

export interface TaskPatchRequest {
  title?: string;
  state?: TaskState;
  owner_role?: string;
  dependencies?: string[];
  write_set?: string[];
  acceptance?: string[];
  artifacts?: string[];
  priority?: number;
  alert?: string | null;
}
