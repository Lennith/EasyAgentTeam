import { useState, useEffect } from "react";
import { useTranslation } from "@/hooks/i18n";
import { useSettings } from "@/hooks/useSettings";
import type { ProjectDetail, SessionRecord, TaskTreeNode, LockRecord, EventRecord, AgentIOTimelineItem } from "@/types";
import { projectApi } from "@/services/api";
import * as mockData from "@/mock/data";
import { Save, Loader, RefreshCw, Settings, Play, Pause } from "lucide-react";

interface ProjectSettingsViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

export function ProjectSettingsView({ projectId, project }: ProjectSettingsViewProps) {
  const t = useTranslation();
  const { settings: appSettings } = useSettings();
  const [orchSettings, setOrchSettings] = useState<{
    project_id: string;
    auto_dispatch_enabled: boolean;
    auto_dispatch_remaining: number;
    hold_enabled?: boolean;
    reminder_mode?: "backoff" | "fixed_interval";
    updated_at: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [autoDispatchEnabled, setAutoDispatchEnabled] = useState(false);
  const [autoDispatchRemaining, setAutoDispatchRemaining] = useState(0);
  const [holdEnabled, setHoldEnabled] = useState(false);
  const [reminderMode, setReminderMode] = useState<"backoff" | "fixed_interval">("backoff");

  useEffect(() => {
    let closed = false;
    async function load() {
      if (appSettings.useMockData) {
        if (!closed) {
          setOrchSettings(mockData.mockOrchestratorSettings);
          setAutoDispatchEnabled(mockData.mockOrchestratorSettings.auto_dispatch_enabled);
          setAutoDispatchRemaining(mockData.mockOrchestratorSettings.auto_dispatch_remaining);
          setHoldEnabled(Boolean(mockData.mockOrchestratorSettings.hold_enabled));
          setReminderMode(mockData.mockOrchestratorSettings.reminder_mode ?? "backoff");
          setError(null);
          setLoading(false);
        }
        return;
      }

      try {
        const orchData = await projectApi.getOrchestratorSettings(projectId);
        if (!closed) {
          setOrchSettings(orchData);
          setAutoDispatchEnabled(orchData.auto_dispatch_enabled);
          setAutoDispatchRemaining(orchData.auto_dispatch_remaining);
          setHoldEnabled(Boolean(orchData.hold_enabled));
          setReminderMode(orchData.reminder_mode ?? "backoff");
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load settings");
        }
      } finally {
        if (!closed) setLoading(false);
      }
    }
    load();
    return () => {
      closed = true;
    };
  }, [projectId, appSettings.useMockData]);

  async function onSave() {
    if (appSettings.useMockData) {
      setOrchSettings({
        project_id: projectId,
        auto_dispatch_enabled: autoDispatchEnabled,
        auto_dispatch_remaining: autoDispatchRemaining,
        hold_enabled: holdEnabled,
        reminder_mode: reminderMode,
        updated_at: new Date().toISOString()
      });
      setSuccess(t.settingsSaved);
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      await projectApi.updateOrchestratorSettings(projectId, {
        auto_dispatch_enabled: autoDispatchEnabled,
        auto_dispatch_remaining: autoDispatchRemaining,
        hold_enabled: holdEnabled,
        reminder_mode: reminderMode
      });

      setSuccess(t.settingsSaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function onRefresh() {
    if (appSettings.useMockData) {
      setOrchSettings(mockData.mockOrchestratorSettings);
      setAutoDispatchEnabled(mockData.mockOrchestratorSettings.auto_dispatch_enabled);
      setAutoDispatchRemaining(mockData.mockOrchestratorSettings.auto_dispatch_remaining);
      setHoldEnabled(Boolean(mockData.mockOrchestratorSettings.hold_enabled));
      setReminderMode(mockData.mockOrchestratorSettings.reminder_mode ?? "backoff");
      return;
    }

    setLoading(true);
    try {
      const orchData = await projectApi.getOrchestratorSettings(projectId);
      setOrchSettings(orchData);
      setAutoDispatchEnabled(orchData.auto_dispatch_enabled);
      setAutoDispatchRemaining(orchData.auto_dispatch_remaining);
      setHoldEnabled(Boolean(orchData.hold_enabled));
      setReminderMode(orchData.reminder_mode ?? "backoff");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh settings");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.projectSettings}</h1>
        </div>
        <div className="empty-state">
          <Loader size={24} className="loading-spinner" />
          <p>{t.loadingSettings}</p>
        </div>
      </section>
    );
  }

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.projectSettings}</h1>
        <button className="btn btn-secondary btn-sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} />
          {t.refresh}
        </button>
      </div>

      {error && (
        <div className="error-message" style={{ flexShrink: 0 }}>
          {error}
        </div>
      )}
      {success && (
        <div className="success-message" style={{ flexShrink: 0 }}>
          {success}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingRight: "4px" }}>
        <div className="card">
          <div className="card-header">
            <Settings size={18} />
            <h3>{t.orchestratorSettings}</h3>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px",
              background: "var(--bg-elevated)",
              borderRadius: "8px",
              marginBottom: "16px"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              {autoDispatchEnabled ? (
                <Play size={20} style={{ color: "var(--accent-success)" }} />
              ) : (
                <Pause size={20} style={{ color: "var(--text-muted)" }} />
              )}
              <div>
                <div style={{ fontWeight: 500 }}>{t.autoDispatch}</div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  {autoDispatchEnabled ? t.autoDispatchEnabledDesc : t.autoDispatchDisabledDesc}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                className={`btn ${autoDispatchEnabled ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setAutoDispatchEnabled(true)}
              >
                <Play size={14} />
                {t.enabled}
              </button>
              <button
                className={`btn ${!autoDispatchEnabled ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setAutoDispatchEnabled(false)}
              >
                <Pause size={14} />
                {t.disabled}
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>{t.autoDispatchRemaining}</label>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <input
                type="number"
                value={autoDispatchRemaining}
                onChange={(e) => setAutoDispatchRemaining(Math.max(0, parseInt(e.target.value) || 0))}
                style={{ width: "120px" }}
                min="0"
              />
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.autoDispatchRemainingDesc}</span>
            </div>
          </div>

          <div className="form-group">
            <label>Hold</label>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                className={`btn ${holdEnabled ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setHoldEnabled(true)}
              >
                {t.enabled}
              </button>
              <button
                className={`btn ${!holdEnabled ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setHoldEnabled(false)}
              >
                {t.disabled}
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>Reminder Mode</label>
            <select
              value={reminderMode}
              onChange={(e) => setReminderMode(e.target.value as "backoff" | "fixed_interval")}
            >
              <option value="backoff">backoff</option>
              <option value="fixed_interval">fixed_interval</option>
            </select>
          </div>

          {orchSettings && (
            <div
              style={{
                fontSize: "12px",
                color: "var(--text-muted)",
                marginTop: "12px",
                padding: "8px 12px",
                background: "var(--bg-surface)",
                borderRadius: "6px"
              }}
            >
              <div>
                Project ID: <code>{orchSettings.project_id}</code>
              </div>
              <div>
                {t.updatedAt}: {new Date(orchSettings.updated_at).toLocaleString()}
              </div>
            </div>
          )}

          <div style={{ marginTop: "20px" }}>
            <button className="btn btn-primary btn-lg" disabled={saving} onClick={onSave}>
              {saving ? <Loader size={18} className="loading-spinner" /> : <Save size={18} />}
              {saving ? t.saving : t.save}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>{t.projectInfo}</h3>
          </div>

          {project ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-muted)", width: "120px" }}>Name:</span>
                <span style={{ fontSize: "13px" }}>{project.name}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-muted)", width: "120px" }}>{t.projectId}:</span>
                <code style={{ fontSize: "12px" }}>{project.projectId}</code>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-muted)", width: "120px" }}>{t.workspacePath}:</span>
                <code style={{ fontSize: "12px", wordBreak: "break-all" }}>{project.workspacePath}</code>
              </div>
              {project.createdAt && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", width: "120px" }}>{t.createdAt}:</span>
                  <span style={{ fontSize: "13px" }}>{new Date(project.createdAt).toLocaleString()}</span>
                </div>
              )}
              {project.agentIds && project.agentIds.length > 0 && (
                <div style={{ marginTop: "8px" }}>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Agents:</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px" }}>
                    {project.agentIds.map((agent) => (
                      <span key={agent} className="badge badge-neutral">
                        {agent}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: "16px" }}>
              <p>{t.noProjectInfo}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
