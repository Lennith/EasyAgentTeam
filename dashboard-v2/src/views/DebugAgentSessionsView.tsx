import { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import { useSettings } from "@/hooks/useSettings";
import type { SessionRecord, ProjectSummary, AgentIOTimelineItem } from "@/types";
import { projectApi } from "@/services/api";
import * as mockData from "@/mock/data";
import { Loader, Bug, Activity } from "lucide-react";

export function DebugAgentSessionsView() {
  const t = useTranslation();
  const { settings } = useSettings();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [timeline, setTimeline] = useState<AgentIOTimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
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
    return () => {
      closed = true;
    };
  }, [settings.useMockData]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSessions([]);
      setTimeline([]);
      return;
    }

    let closed = false;
    async function loadData() {
      setLoadingData(true);

      if (settings.useMockData) {
        if (!closed) {
          setSessions(mockData.mockSessions);
          setTimeline(mockData.mockTimeline);
          setLoadingData(false);
        }
        return;
      }

      try {
        const [sessionRes, timelineRes] = await Promise.all([
          projectApi.getSessions(selectedProjectId),
          projectApi.getAgentIOTimeline(selectedProjectId, 100)
        ]);
        if (!closed) {
          setSessions(sessionRes.items ?? []);
          setTimeline(timelineRes.items ?? []);
        }
      } catch (err) {
        if (!closed) {
          console.error("Failed to load debug data:", err);
        }
      } finally {
        if (!closed) setLoadingData(false);
      }
    }
    loadData();
    return () => {
      closed = true;
    };
  }, [selectedProjectId, settings.useMockData]);

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.debugSessions}</h1>
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
          <h1>{t.debugSessions}</h1>
        </div>
        <div className="error-message">{error}</div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>{t.debugSessions}</h1>
      </div>

      <div className="card">
        <div className="form-group" style={{ marginBottom: "16px" }}>
          <label>{t.projectId}</label>
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
            {loadingData && <Loader size={16} className="loading-spinner" />}
          </div>
        </div>
      </div>

      {selectedProjectId && (
        <>
          <div className="card">
            <div className="card-header">
              <h3>{t.sessions}</h3>
              <span className="badge badge-neutral">{sessions.length}</span>
            </div>

            <div className="table-container">
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
                  {sessions.map((session) => (
                    <tr key={session.sessionId}>
                      <td>
                        <code>{session.sessionId.slice(0, 24)}...</code>
                      </td>
                      <td>
                        <span className="badge badge-neutral">{session.role}</span>
                      </td>
                      <td>
                        <span
                          className={`badge ${session.status === "running" ? "badge-success" : session.status === "idle" ? "badge-neutral" : "badge-warning"}`}
                        >
                          {session.status}
                        </span>
                      </td>
                      <td>
                        {session.currentTaskId ? (
                          <code>{session.currentTaskId.slice(0, 16)}...</code>
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

            {sessions.length === 0 && (
              <div className="empty-state" style={{ padding: "24px" }}>
                <Bug size={32} style={{ opacity: 0.3 }} />
                <p>{t.noData}</p>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h3>{t.agentIO}</h3>
              <span className="badge badge-neutral">{timeline.length}</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "400px", overflow: "auto" }}>
              {timeline.slice(0, 50).map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: "12px",
                    background: "var(--bg-elevated)",
                    borderRadius: "6px",
                    borderLeft: `3px solid ${item.direction === "inbound" ? "var(--accent-primary)" : "var(--accent-success)"}`
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className="badge badge-neutral">{item.role}</span>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                        {item.direction === "inbound" ? "←" : "→"}
                      </span>
                      <span className="badge badge-primary">{item.messageType}</span>
                    </div>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {item.summary && <div style={{ fontSize: "13px", marginTop: "4px" }}>{item.summary}</div>}
                </div>
              ))}
            </div>

            {timeline.length === 0 && (
              <div className="empty-state" style={{ padding: "24px" }}>
                <Activity size={32} style={{ opacity: 0.3 }} />
                <p>{t.noData}</p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
