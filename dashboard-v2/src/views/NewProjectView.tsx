import { useState, useEffect } from "react";
import { useTranslation } from "@/hooks/i18n";
import type { TemplateDefinition, AgentDefinition, TeamSummary } from "@/types";
import { projectApi, projectTemplateApi, agentApi, teamApi } from "@/services/api";
import { Plus, Loader, ArrowLeft } from "lucide-react";

export function NewProjectView() {
  const t = useTranslation();
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [selectedTeam, setSelectedTeam] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);

  useEffect(() => {
    let closed = false;
    async function load() {
      try {
        const [templateRes, agentRes, teamRes] = await Promise.all([
          projectTemplateApi.list(),
          agentApi.list(),
          teamApi.list()
        ]);
        if (!closed) {
          setTemplates(templateRes.items ?? []);
          setAgents(agentRes.items ?? []);
          setTeams(teamRes.items ?? []);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!closed) setLoading(false);
      }
    }
    load();
    return () => {
      closed = true;
    };
  }, []);

  async function onCreate() {
    try {
      setCreating(true);
      setError(null);
      setSuccess(null);

      await projectApi.create({
        project_id: projectId,
        name,
        workspace_path: workspacePath,
        template_id: selectedTemplate || undefined,
        team_id: selectedTeam || undefined,
        agent_ids: selectedAgents.length > 0 ? selectedAgents : undefined
      });

      setSuccess(`Project "${name}" created!`);
      window.location.hash = `#/project/${projectId}/timeline`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  function toggleAgent(agentId: string) {
    setSelectedAgents((prev) => (prev.includes(agentId) ? prev.filter((a) => a !== agentId) : [...prev, agentId]));
  }

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.createProject}</h1>
        </div>
        <div className="empty-state">
          <Loader size={24} className="loading-spinner" />
          <p>{t.loading}</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>{t.createProject}</h1>
        <a href="#/projects" className="btn btn-secondary">
          <ArrowLeft size={14} /> {t.projects}
        </a>
      </div>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      <div className="card">
        <div className="form-group">
          <label>{t.projectId} *</label>
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="my_project" />
        </div>

        <div className="form-group">
          <label>{t.projectName} *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Project" />
        </div>

        <div className="form-group">
          <label>{t.workspacePath} *</label>
          <input
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
            placeholder="/path/to/workspace"
          />
        </div>

        <div className="form-group">
          <label>{t.templates}</label>
          <select value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}>
            <option value="">{t.selectTemplate}</option>
            {templates.map((tpl) => (
              <option key={tpl.templateId} value={tpl.templateId}>
                {tpl.name}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>{t.teams}</label>
          <select value={selectedTeam} onChange={(e) => setSelectedTeam(e.target.value)}>
            <option value="">{t.selectTeam}</option>
            {teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.name} ({team.agentCount} {t.memberCount})
              </option>
            ))}
          </select>
          <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
            Select a team to copy agent configuration and routing tables
          </p>
        </div>

        <div className="form-group">
          <label>{t.agents}</label>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "8px" }}>
            Select agents to include in this project. Only registered agents can be selected.
          </p>
          {agents.length === 0 ? (
            <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>No agents available</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {agents.map((agent) => (
                <button
                  key={agent.agentId}
                  type="button"
                  className={`btn ${selectedAgents.includes(agent.agentId) ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => toggleAgent(agent.agentId)}
                >
                  {agent.displayName}
                </button>
              ))}
            </div>
          )}
          {selectedAgents.length > 0 && (
            <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "8px" }}>
              Selected: {selectedAgents.join(", ")}
            </p>
          )}
        </div>

        <div style={{ marginTop: "20px" }}>
          <button
            className="btn btn-primary btn-lg"
            disabled={creating || !projectId || !name || !workspacePath}
            onClick={onCreate}
          >
            {creating ? <Loader size={18} className="loading-spinner" /> : <Plus size={18} />}
            {creating ? t.creatingProject : t.createProject}
          </button>
        </div>
      </div>
    </section>
  );
}
