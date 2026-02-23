import { useEffect, useState, useMemo } from "react";
import { useTranslation } from "@/hooks/i18n";
import { useSettings } from "@/hooks/useSettings";
import type { SessionRecord, ProjectSummary } from "@/types";
import { projectApi } from "@/services/api";
import * as mockData from "@/mock/data";
import { Users, Loader } from "lucide-react";

export function AgentSessionsView() {
  const t = useTranslation();
  const { settings } = useSettings();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    async function loadProjects() {
      if (settings.useMockData) {
        if (!closed) {
          setProjects(mockData.mockProjects);
          if (mockData.mockProjects.length > 0) {
            setSelectedProjectId(mockData.mockProjects[0].projectId);
          }
          setError(null);
          setLoading(false);
        }
        return;
      }
      
      try {
        const data = await projectApi.list();
        if (!closed) {
          setProjects(data.items ?? []);
          if ((data.items?.length ?? 0) > 0) {
            setSelectedProjectId(data.items![0].projectId);
          }
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load projects");
        }
      } finally {
        if (!closed) setLoading(false);
      }
    }
    loadProjects();
    return () => { closed = true; };
  }, [settings.useMockData]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSessions([]);
      return;
    }
    
    let closed = false;
    async function loadSessions() {
      setLoadingSessions(true);
      
      if (settings.useMockData) {
        if (!closed) {
          setSessions(mockData.mockSessions);
          setLoadingSessions(false);
        }
        return;
      }
      
      try {
        const data = await projectApi.getSessions(selectedProjectId);
        if (!closed) {
          setSessions(data.items ?? []);
        }
      } catch (err) {
        if (!closed) {
          console.error("Failed to load sessions:", err);
          setSessions([]);
        }
      } finally {
        if (!closed) setLoadingSessions(false);
      }
    }
    loadSessions();
    return () => { closed = true; };
  }, [selectedProjectId, settings.useMockData]);

  const allSessions = useMemo(() => {
    return sessions.map(s => ({
      ...s,
      projectName: projects.find(p => p.projectId === s.projectId)?.name ?? s.projectId,
    }));
  }, [sessions, projects]);

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.agentSessions}</h1>
        </div>
        <div className="empty-state">
          <Loader size={24} className="loading-spinner" />
          <p>{t.loading}</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.agentSessions}</h1>
        </div>
        <div className="error-message">{error}</div>
      </section>
    );
  }

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.agentSessions}</h1>
      </div>

      <div className="card" style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div className="form-group" style={{ marginBottom: "16px", flexShrink: 0, padding: "16px 16px 0" }}>
          <label>Select Project</label>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <select 
              value={selectedProjectId} 
              onChange={(e) => setSelectedProjectId(e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">-- Select a project --</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name} ({p.projectId})
                </option>
              ))}
            </select>
            {loadingSessions && <Loader size={16} className="loading-spinner" />}
          </div>
        </div>

        <div className="card-header" style={{ marginTop: "0", flexShrink: 0, padding: "12px 16px" }}>
          <h3>{t.sessions}</h3>
          <span className="badge badge-neutral">{allSessions.length}</span>
        </div>

        {selectedProjectId ? (
          <div className="table-container" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 16px 16px" }}>
            <table>
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Current Task</th>
                  <th>Created</th>
                  <th>Last Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {allSessions.map((session) => (
                  <tr key={session.sessionId}>
                    <td><code>{session.sessionId.slice(0, 24)}...</code></td>
                    <td><span className="badge badge-neutral">{session.role}</span></td>
                    <td>
                      <span className={`badge ${session.status === "running" ? "badge-success" : session.status === "idle" ? "badge-neutral" : "badge-warning"}`}>
                        {session.status}
                      </span>
                    </td>
                    <td>
                      {session.currentTaskId ? (
                        <a href={`#/project/${session.projectId}/task-tree`}>
                          <code>{session.currentTaskId.slice(0, 16)}...</code>
                        </a>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>-</span>
                      )}
                    </td>
                    <td style={{ fontSize: "12px" }}>{new Date(session.createdAt).toLocaleString()}</td>
                    <td style={{ fontSize: "12px" }}>
                      {session.lastHeartbeat ? new Date(session.lastHeartbeat).toLocaleString() : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state" style={{ padding: "24px", flexShrink: 0 }}>
            <Users size={32} style={{ opacity: 0.3 }} />
            <p>Select a project to view sessions</p>
          </div>
        )}

        {selectedProjectId && allSessions.length === 0 && !loadingSessions && (
          <div className="empty-state" style={{ padding: "24px", flexShrink: 0 }}>
            <Users size={32} style={{ opacity: 0.3 }} />
            <p>{t.noData}</p>
          </div>
        )}
      </div>
    </section>
  );
}
