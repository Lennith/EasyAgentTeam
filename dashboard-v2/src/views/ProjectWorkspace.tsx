import { useProjectWorkspace } from "@/hooks/useData";
import { useTranslation } from "@/hooks/i18n";
import type { ProjectView } from "@/types";
import { EventTimelineView } from "./EventTimelineView";
import { ChatTimelineView } from "./ChatTimelineView";
import { SessionManagerView } from "./SessionManagerView";
import { AgentIOView } from "./AgentIOView";
import { AgentChatView } from "./AgentChatView";
import { TaskboardView } from "./TaskboardView";
import { TaskTreeView } from "./TaskTreeView";
import { CreateTaskView } from "./CreateTaskView";
import { UpdateTaskView } from "./UpdateTaskView";
import { LockManagerView } from "./LockManagerView";
import { RoutingConfigView } from "./RoutingConfigView";
import { ProjectSettingsView } from "./ProjectSettingsView";

interface ProjectWorkspaceProps {
  projectId: string;
  view: ProjectView;
}

export function ProjectWorkspace({ projectId, view }: ProjectWorkspaceProps) {
  const t = useTranslation();
  const workspace = useProjectWorkspace(projectId);

  const viewTitles: Record<ProjectView, string> = {
    timeline: t.eventTimeline,
    chat: t.chatTimeline,
    "session-manager": t.sessionManager,
    "agent-io": t.agentIO,
    "agent-chat": t.agentChat,
    taskboard: t.taskboard,
    "task-tree": t.taskTree,
    "task-create": t.createTask,
    "task-update": t.updateTask,
    "lock-manager": t.lockManager,
    "team-config": t.teamConfig,
    "project-settings": t.projectSettings
  };

  if (workspace.loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{viewTitles[view]}</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>{t.loading}</p>
        </div>
      </section>
    );
  }

  if (workspace.error) {
    return (
      <section>
        <div className="page-header">
          <h1>{viewTitles[view]}</h1>
        </div>
        <div className="error-message">{workspace.error}</div>
      </section>
    );
  }

  const viewProps = {
    projectId,
    project: workspace.project,
    sessions: workspace.sessions,
    tasks: workspace.tasks,
    locks: workspace.locks,
    events: workspace.events,
    timeline: workspace.timeline,
    reload: workspace.reload
  };

  switch (view) {
    case "timeline":
      return <EventTimelineView {...viewProps} />;
    case "chat":
      return <ChatTimelineView {...viewProps} />;
    case "session-manager":
      return <SessionManagerView {...viewProps} />;
    case "agent-io":
      return <AgentIOView {...viewProps} />;
    case "agent-chat":
      return <AgentChatView projectId={projectId} sessions={workspace.sessions} />;
    case "taskboard":
      return <TaskboardView {...viewProps} />;
    case "task-tree":
      return <TaskTreeView {...viewProps} />;
    case "task-create":
      return <CreateTaskView {...viewProps} />;
    case "task-update":
      return <UpdateTaskView {...viewProps} />;
    case "lock-manager":
      return <LockManagerView {...viewProps} />;
    case "team-config":
      return <RoutingConfigView {...viewProps} />;
    case "project-settings":
      return <ProjectSettingsView {...viewProps} />;
    default:
      return <div>Unknown view</div>;
  }
}
