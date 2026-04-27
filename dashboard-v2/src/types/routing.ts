import type { AgentView, DebugView, SkillView } from "./catalog";
import type { ProjectView } from "./project";
import type { TeamView } from "./team";
import type { WorkflowRunWorkspaceView, WorkflowView } from "./workflow";

export type L1Route =
  | { l1: "home" }
  | { l1: "new-project" }
  | { l1: "projects" }
  | { l1: "project"; projectId: string; view?: ProjectView }
  | { l1: "teams"; view?: TeamView; teamId?: string }
  | { l1: "workflow"; view?: WorkflowView; runId?: string; runView?: WorkflowRunWorkspaceView; templateId?: string }
  | { l1: "skills"; view?: SkillView }
  | { l1: "agents"; view?: AgentView }
  | { l1: "debug"; debugView?: DebugView }
  | { l1: "settings" };
