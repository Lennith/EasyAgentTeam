import { useRoute } from "@/hooks/useRoute";
import { useProjects } from "@/hooks/useData";
import { useOrchestratorStatus } from "@/hooks/useData";
import { useTranslation } from "@/hooks/i18n";
import { useEffect } from "react";
import { ProjectsHome } from "@/views/ProjectsHome";
import { ProjectWorkspace } from "@/views/ProjectWorkspace";
import { NewProjectView } from "@/views/NewProjectView";
import { AgentSessionsView } from "@/views/AgentSessionsView";
import { AgentRegistryView } from "@/views/AgentRegistryView";
import { AgentTemplatesView } from "@/views/AgentTemplatesView";
import { DebugAgentSessionsView } from "@/views/DebugAgentSessionsView";
import { AgentLogView } from "@/views/AgentLogView";
import { SettingsView } from "@/views/SettingsView";
import { TeamsHome } from "@/views/TeamsHome";
import { TeamEditorView } from "@/views/TeamEditorView";
import { NewTeamView } from "@/views/NewTeamView";
import { WorkflowTemplatesView } from "@/views/WorkflowTemplatesView";
import { WorkflowTemplateEditorView } from "@/views/WorkflowTemplateEditorView";
import { WorkflowRunsView } from "@/views/WorkflowRunsView";
import { WorkflowRunWizardView } from "@/views/WorkflowRunWizardView";
import { WorkflowRunWorkspaceView } from "@/views/WorkflowRunWorkspaceView";
import { projectApi, settingsApi } from "@/services/api";
import {
  Home,
  FolderKanban,
  Users,
  Bug,
  Settings,
  ChevronRight,
  Activity,
  Cpu,
  Zap,
  UserCircle,
  GitBranch
} from "lucide-react";

export default function App() {
  const { route } = useRoute();
  const t = useTranslation();
  const { projects, loading: projectsLoading, error: projectsError, reload: reloadProjects } = useProjects();
  const { status: orchestratorStatus } = useOrchestratorStatus();

  // Apply theme on app load (local fallback + server persisted value)
  useEffect(() => {
    async function applyTheme() {
      try {
        const localTheme = localStorage.getItem("dashboard_theme");
        if (localTheme === "dark" || localTheme === "vibrant" || localTheme === "lively") {
          document.documentElement.setAttribute("data-theme", localTheme);
        }
      } catch {
        // ignore local storage errors
      }

      try {
        const settings = await settingsApi.get();
        if (settings.theme) {
          document.documentElement.setAttribute("data-theme", settings.theme);
          try {
            localStorage.setItem("dashboard_theme", settings.theme);
          } catch {
            // ignore local storage errors
          }
        }
      } catch (e) {
        console.error("Failed to load theme:", e);
      }
    }
    applyTheme();
  }, []);

  const handleDeleteProject = async (projectId: string) => {
    try {
      await projectApi.delete(projectId);
      reloadProjects();
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  };

  const l1NavItems = [
    { id: "home", icon: <Home size={18} />, label: t.home },
    { id: "projects", icon: <FolderKanban size={18} />, label: t.projects },
    { id: "workflow", icon: <GitBranch size={18} />, label: t.workflow },
    { id: "teams", icon: <UserCircle size={18} />, label: t.teams },
    { id: "agents", icon: <Users size={18} />, label: t.agents },
    { id: "debug", icon: <Bug size={18} />, label: t.debug },
    { id: "settings", icon: <Settings size={18} />, label: t.settings }
  ];

  const agentViews = [
    { id: "sessions", label: t.sessions },
    { id: "agents", label: t.agentRegistry },
    { id: "templates", label: t.agentTemplates }
  ];

  const debugViews = [
    { id: "agent-sessions", label: t.debugSessions },
    { id: "codex-output", label: t.codexOutput }
  ];

  const workflowViews = [
    { id: "new-run", label: `+ ${t.newWorkflowRun}`, href: "#/workflow/runs/new" },
    { id: "new-template", label: `+ ${t.newWorkflowTemplate}`, href: "#/workflow/templates/new" },
    { id: "runs", label: t.workflowRuns, href: "#/workflow" },
    { id: "templates", label: t.workflowTemplates, href: "#/workflow/templates" }
  ];

  const workflowWorkspaceViews = [
    { id: "overview", label: "Run Overview" },
    { id: "task-tree", label: t.taskTree },
    { id: "chat", label: t.chatTimeline },
    { id: "agent-chat", label: t.agentChat },
    { id: "team-config", label: t.teamConfig }
  ] as const;

  const projectViews: { id: string; icon: React.ReactNode; label: string }[] = [
    { id: "timeline", icon: <Activity size={16} />, label: t.eventTimeline },
    { id: "chat", icon: <ChevronRight size={16} />, label: t.chatTimeline },
    { id: "session-manager", icon: <Users size={16} />, label: t.sessionManager },
    { id: "agent-io", icon: <Zap size={16} />, label: t.agentIO },
    { id: "agent-chat", icon: <Cpu size={16} />, label: t.agentChat },
    { id: "taskboard", icon: <Activity size={16} />, label: t.taskboard },
    { id: "task-tree", icon: <FolderKanban size={16} />, label: t.taskTree },
    { id: "task-create", icon: <ChevronRight size={16} />, label: t.createTask },
    { id: "task-update", icon: <ChevronRight size={16} />, label: t.updateTask },
    { id: "lock-manager", icon: <Settings size={16} />, label: t.lockManager },
    { id: "team-config", icon: <Users size={16} />, label: t.teamConfig },
    { id: "project-settings", icon: <Settings size={16} />, label: t.projectSettings }
  ];

  function renderMain() {
    if (route.l1 === "home") {
      return (
        <section>
          <div className="page-header">
            <h1>{t.home}</h1>
          </div>
          <div className="card">
            <div className="card-header">
              <h3>{t.orchestratorHealth}</h3>
            </div>
            {orchestratorStatus ? (
              <div
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}
              >
                <div style={{ padding: "12px", background: "var(--bg-elevated)", borderRadius: "8px" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.orchestratorEnabled}</div>
                  <div
                    style={{
                      fontWeight: 600,
                      color: orchestratorStatus.enabled ? "var(--accent-success)" : "var(--text-muted)"
                    }}
                  >
                    {orchestratorStatus.enabled ? "Yes" : "No"}
                  </div>
                </div>
                <div style={{ padding: "12px", background: "var(--bg-elevated)", borderRadius: "8px" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.orchestratorRunning}</div>
                  <div
                    style={{
                      fontWeight: 600,
                      color: orchestratorStatus.running ? "var(--accent-success)" : "var(--accent-danger)"
                    }}
                  >
                    {orchestratorStatus.running ? "Yes" : "No"}
                  </div>
                </div>
                <div style={{ padding: "12px", background: "var(--bg-elevated)", borderRadius: "8px" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.pendingMessages}</div>
                  <div style={{ fontWeight: 600 }}>{orchestratorStatus.pendingMessages}</div>
                </div>
                <div style={{ padding: "12px", background: "var(--bg-elevated)", borderRadius: "8px" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.dispatchedMessages}</div>
                  <div style={{ fontWeight: 600 }}>{orchestratorStatus.dispatchedMessages}</div>
                </div>
                <div style={{ padding: "12px", background: "var(--bg-elevated)", borderRadius: "8px" }}>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.failedDispatches}</div>
                  <div
                    style={{
                      fontWeight: 600,
                      color: orchestratorStatus.failedDispatches > 0 ? "var(--accent-danger)" : "inherit"
                    }}
                  >
                    {orchestratorStatus.failedDispatches}
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-state" style={{ padding: "16px" }}>
                <p>{t.loading}</p>
              </div>
            )}
          </div>
        </section>
      );
    }

    if (route.l1 === "new-project") {
      return <NewProjectView />;
    }

    if (route.l1 === "projects") {
      return (
        <ProjectsHome
          projects={projects}
          loading={projectsLoading}
          error={projectsError}
          onDelete={handleDeleteProject}
        />
      );
    }

    if (route.l1 === "project") {
      return <ProjectWorkspace projectId={route.projectId} view={route.view ?? "timeline"} />;
    }

    if (route.l1 === "agents") {
      const view = route.view ?? "sessions";
      if (view === "sessions") return <AgentSessionsView />;
      if (view === "agents") return <AgentRegistryView />;
      if (view === "templates") return <AgentTemplatesView />;
    }

    if (route.l1 === "teams") {
      const view = route.view ?? "list";
      if (view === "list") return <TeamsHome />;
      if (view === "new") return <NewTeamView />;
      if (view === "edit" && route.teamId) return <TeamEditorView teamId={route.teamId} />;
    }

    if (route.l1 === "workflow") {
      const view = route.view ?? "runs";
      if (view === "runs") return <WorkflowRunsView />;
      if (view === "new-run") return <WorkflowRunWizardView />;
      if (view === "templates") return <WorkflowTemplatesView />;
      if (view === "new-template") return <WorkflowTemplateEditorView />;
      if (view === "edit-template" && route.templateId)
        return <WorkflowTemplateEditorView templateId={route.templateId} />;
      if (view === "run-workspace" && route.runId) {
        return <WorkflowRunWorkspaceView runId={route.runId} view={route.runView ?? "overview"} />;
      }
      return <WorkflowRunsView />;
    }

    if (route.l1 === "debug") {
      const debugView = route.debugView ?? "agent-sessions";
      if (debugView === "agent-sessions") return <DebugAgentSessionsView />;
      if (debugView === "codex-output") return <AgentLogView />;
    }

    if (route.l1 === "settings") {
      return <SettingsView />;
    }

    return <div>Unknown route</div>;
  }

  function renderL2Nav() {
    if (route.l1 === "teams") {
      return (
        <div className="l2-nav">
          <a href="#/teams" className={`l2-nav-item ${route.view === "list" || !route.view ? "active" : ""}`}>
            {t.teamList}
          </a>
          <a href="#/teams/new" className={`l2-nav-item ${route.view === "new" ? "active" : ""}`}>
            + {t.newTeam}
          </a>
        </div>
      );
    }

    if (route.l1 === "agents") {
      return (
        <div className="l2-nav">
          {agentViews.map((v) => (
            <a key={v.id} href={`#/agents/${v.id}`} className={`l2-nav-item ${route.view === v.id ? "active" : ""}`}>
              {v.label}
            </a>
          ))}
        </div>
      );
    }

    if (route.l1 === "workflow") {
      if (route.view === "run-workspace" && route.runId) {
        return (
          <div className="l2-nav">
            <div style={{ padding: "8px 12px", fontSize: "12px", color: "var(--text-muted)", fontWeight: 600 }}>
              {route.runId}
            </div>
            {workflowWorkspaceViews.map((v) => (
              <a
                key={v.id}
                href={`#/workflow/runs/${route.runId}/${v.id}`}
                className={`l2-nav-item ${route.runView === v.id ? "active" : ""}`}
              >
                {v.label}
              </a>
            ))}
            <a className="l2-nav-item" href="#/workflow">
              Back to List
            </a>
          </div>
        );
      }
      return (
        <div className="l2-nav">
          {workflowViews.map((v) => {
            const active =
              route.view === v.id ||
              (v.id === "templates" && (route.view === "edit-template" || route.view === "templates"));
            return (
              <a key={v.id} href={v.href} className={`l2-nav-item ${active ? "active" : ""}`}>
                {v.label}
              </a>
            );
          })}
        </div>
      );
    }

    if (route.l1 === "debug") {
      return (
        <div className="l2-nav">
          {debugViews.map((v) => (
            <a
              key={v.id}
              href={`#/debug/${v.id}`}
              className={`l2-nav-item ${route.debugView === v.id ? "active" : ""}`}
            >
              {v.label}
            </a>
          ))}
        </div>
      );
    }

    if (route.l1 === "project") {
      return (
        <div className="l2-nav">
          <div style={{ padding: "8px 12px", fontSize: "12px", color: "var(--text-muted)", fontWeight: 600 }}>
            {route.projectId}
          </div>
          {projectViews.map((v) => (
            <a
              key={v.id}
              href={`#/project/${route.projectId}/${v.id}`}
              className={`l2-nav-item ${route.view === v.id ? "active" : ""}`}
            >
              {v.icon}
              {v.label}
            </a>
          ))}
        </div>
      );
    }

    return null;
  }

  return (
    <div className="app">
      <nav className="l1-nav">
        <div className="l1-nav-header">
          <Cpu size={24} />
          <span>Agent Dashboard</span>
        </div>
        {l1NavItems.map((item) => (
          <a
            key={item.id}
            href={`#/${item.id === "home" ? "" : item.id}`}
            className={`l1-nav-item ${route.l1 === item.id ? "active" : ""}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </a>
        ))}
      </nav>

      {renderL2Nav()}

      <main className="main-content">{renderMain()}</main>
    </div>
  );
}
