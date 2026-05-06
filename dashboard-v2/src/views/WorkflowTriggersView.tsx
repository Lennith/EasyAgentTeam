import { FormEvent, useMemo, useState } from "react";
import { Play, RefreshCw, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { workflowApi } from "@/services/api/workflow";
import { useWorkflowTemplates, useWorkflowTriggers } from "@/hooks/useWorkflowData";
import type { TriggerRunHistoryItem, TriggerSessionBindingRecord } from "@/types/workflow";

function parseVariables(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const entries = Object.entries(parsed).map(([key, value]) => [key, String(value)] as const);
  return Object.fromEntries(entries);
}

export function WorkflowTriggersView() {
  const { triggers, plugins, loading, error, reload } = useWorkflowTriggers();
  const { items: templates } = useWorkflowTemplates();
  const [pluginSource, setPluginSource] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [historyTriggerId, setHistoryTriggerId] = useState<string | null>(null);
  const [history, setHistory] = useState<TriggerRunHistoryItem[]>([]);
  const [sessionBindings, setSessionBindings] = useState<TriggerSessionBindingRecord[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [form, setForm] = useState({
    triggerId: "",
    pluginId: "",
    enabled: true,
    intervalSeconds: 30,
    workflowTemplateId: "",
    workspacePath: "",
    defaultVariables: "",
    hookTimeoutMs: 30000,
    sessionMode: "fresh" as "fresh" | "reuse_provider_session"
  });

  const pluginOptions = useMemo(() => plugins.map((item) => item.pluginId), [plugins]);
  const templateOptions = useMemo(() => templates.map((item) => item.templateId), [templates]);

  const importPlugin = async (event: FormEvent) => {
    event.preventDefault();
    setWorking("import");
    try {
      const result = await workflowApi.importPlugin({ source: pluginSource });
      setForm((current) => ({ ...current, pluginId: current.pluginId || result.plugin.pluginId }));
      setPluginSource("");
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to import plugin");
    } finally {
      setWorking(null);
    }
  };

  const createTrigger = async (event: FormEvent) => {
    event.preventDefault();
    setWorking("create");
    try {
      const payload = {
        plugin_id: form.pluginId,
        enabled: form.enabled,
        interval_seconds: form.intervalSeconds,
        workflow_template_id: form.workflowTemplateId,
        workspace_path: form.workspacePath,
        default_variables: parseVariables(form.defaultVariables),
        hook_timeout_ms: form.hookTimeoutMs,
        session_mode: form.sessionMode
      };
      if (editingTriggerId) {
        await workflowApi.patchTrigger(editingTriggerId, payload);
      } else {
        await workflowApi.createTrigger({
          trigger_id: form.triggerId,
          ...payload
        });
      }
      setEditingTriggerId(null);
      setForm((current) => ({ ...current, triggerId: "", defaultVariables: "", sessionMode: "fresh" }));
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to save trigger");
    } finally {
      setWorking(null);
    }
  };

  const editTrigger = (triggerId: string) => {
    const trigger = triggers.find((item) => item.triggerId === triggerId);
    if (!trigger) {
      return;
    }
    setEditingTriggerId(triggerId);
    setForm({
      triggerId: trigger.triggerId,
      pluginId: trigger.pluginId,
      enabled: trigger.enabled,
      intervalSeconds: trigger.intervalSeconds,
      workflowTemplateId: trigger.workflowTemplateId,
      workspacePath: trigger.workspacePath,
      defaultVariables: trigger.defaultVariables ? JSON.stringify(trigger.defaultVariables, null, 2) : "",
      hookTimeoutMs: trigger.hookTimeoutMs,
      sessionMode: trigger.sessionMode
    });
  };

  const toggleTrigger = async (triggerId: string, enabled: boolean) => {
    setWorking(triggerId);
    try {
      await workflowApi.patchTrigger(triggerId, { enabled });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to update trigger");
    } finally {
      setWorking(null);
    }
  };

  const deleteTrigger = async (triggerId: string) => {
    if (!window.confirm(`Delete trigger "${triggerId}"?`)) {
      return;
    }
    setWorking(triggerId);
    try {
      await workflowApi.deleteTrigger(triggerId);
      if (historyTriggerId === triggerId) {
        setHistoryTriggerId(null);
        setHistory([]);
        setSessionBindings([]);
      }
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete trigger");
    } finally {
      setWorking(null);
    }
  };

  const runTest = async (triggerId: string) => {
    setWorking(triggerId);
    try {
      const result = await workflowApi.testTrigger(triggerId);
      if (result.status === "failed") {
        window.alert(result.error ?? "Trigger test failed");
      }
      await Promise.all([reload(), loadHistory(triggerId)]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to test trigger");
    } finally {
      setWorking(null);
    }
  };

  const loadHistory = async (triggerId: string) => {
    setHistoryTriggerId(triggerId);
    setHistory([]);
    setSessionBindings([]);
    setHistoryError(null);
    setHistoryLoading(true);
    try {
      const [historyPayload, bindingPayload] = await Promise.all([
        workflowApi.listTriggerRuns(triggerId),
        workflowApi.listTriggerSessionBindings(triggerId)
      ]);
      setHistory(historyPayload.items ?? []);
      setSessionBindings(bindingPayload.items ?? []);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Failed to load trigger history");
    } finally {
      setHistoryLoading(false);
    }
  };

  const resetSessionBindings = async (triggerId: string) => {
    if (!window.confirm(`Reset provider session binding for "${triggerId}"?`)) {
      return;
    }
    setWorking(triggerId);
    try {
      await workflowApi.resetTriggerSessionBindings(triggerId);
      await Promise.all([reload(), loadHistory(triggerId)]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to reset trigger session");
    } finally {
      setWorking(null);
    }
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>Workflow Triggers</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>Loading triggers...</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>Workflow Triggers</h1>
        <button className="btn btn-secondary" onClick={reload}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="card">
        <div className="card-header">
          <h3>Import Plugin</h3>
        </div>
        <form onSubmit={importPlugin} style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>Local Plugin Path</label>
            <input value={pluginSource} onChange={(event) => setPluginSource(event.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={working === "import" || pluginSource.trim().length === 0}>
            <Upload size={14} /> Import
          </button>
        </form>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>{editingTriggerId ? `Edit Trigger: ${editingTriggerId}` : "Create Trigger"}</h3>
        </div>
        <form
          onSubmit={createTrigger}
          style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px" }}
        >
          <div className="form-group">
            <label>Trigger ID</label>
            <input value={form.triggerId} onChange={(event) => setForm({ ...form, triggerId: event.target.value })} />
          </div>
          <div className="form-group">
            <label>Plugin</label>
            <select value={form.pluginId} onChange={(event) => setForm({ ...form, pluginId: event.target.value })}>
              <option value="">Select plugin</option>
              {pluginOptions.map((pluginId) => (
                <option key={pluginId} value={pluginId}>
                  {pluginId}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Workflow Template</label>
            <select
              value={form.workflowTemplateId}
              onChange={(event) => setForm({ ...form, workflowTemplateId: event.target.value })}
            >
              <option value="">Select template</option>
              {templateOptions.map((templateId) => (
                <option key={templateId} value={templateId}>
                  {templateId}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Workspace Path</label>
            <input
              value={form.workspacePath}
              onChange={(event) => setForm({ ...form, workspacePath: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Interval Seconds</label>
            <input
              type="number"
              min={1}
              value={form.intervalSeconds}
              onChange={(event) => setForm({ ...form, intervalSeconds: Number(event.target.value) })}
            />
          </div>
          <div className="form-group">
            <label>Hook Timeout MS</label>
            <input
              type="number"
              min={1}
              value={form.hookTimeoutMs}
              onChange={(event) => setForm({ ...form, hookTimeoutMs: Number(event.target.value) })}
            />
          </div>
          <div className="form-group">
            <label>Session Mode</label>
            <select
              value={form.sessionMode}
              onChange={(event) =>
                setForm({
                  ...form,
                  sessionMode: event.target.value as "fresh" | "reuse_provider_session"
                })
              }
            >
              <option value="fresh">Fresh provider session</option>
              <option value="reuse_provider_session">Reuse provider session</option>
            </select>
          </div>
          <div className="form-group" style={{ gridColumn: "1 / -1" }}>
            <label>Default Variables JSON</label>
            <textarea
              rows={3}
              value={form.defaultVariables}
              onChange={(event) => setForm({ ...form, defaultVariables: event.target.value })}
              placeholder='{"message":"hello"}'
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            Enabled
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              className="btn btn-primary"
              disabled={
                working === "create" ||
                (!editingTriggerId && !form.triggerId.trim()) ||
                !form.pluginId ||
                !form.workflowTemplateId ||
                !form.workspacePath.trim()
              }
            >
              <Save size={14} /> {editingTriggerId ? "Save" : "Create"}
            </button>
            {editingTriggerId && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setEditingTriggerId(null);
                  setForm((current) => ({
                    ...current,
                    triggerId: "",
                    defaultVariables: "",
                    sessionMode: "fresh"
                  }));
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Triggers</h3>
        </div>
        {triggers.length === 0 ? (
          <div className="empty-state" style={{ padding: "24px 12px" }}>
            <p>No triggers configured.</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Trigger ID</th>
                  <th>Plugin</th>
                  <th>Template</th>
                  <th>Session</th>
                  <th>Interval</th>
                  <th>Enabled</th>
                  <th>Next Check</th>
                  <th>Last Fire</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {triggers.map((trigger) => (
                  <tr key={trigger.triggerId}>
                    <td>
                      <code>{trigger.triggerId}</code>
                    </td>
                    <td>{trigger.pluginId}</td>
                    <td>{trigger.workflowTemplateId}</td>
                    <td>
                      <span
                        className={`badge ${
                          trigger.sessionMode === "reuse_provider_session" ? "badge-primary" : "badge-neutral"
                        }`}
                      >
                        {trigger.sessionMode === "reuse_provider_session" ? "reuse provider" : "fresh"}
                      </span>
                    </td>
                    <td>{trigger.intervalSeconds}s</td>
                    <td>
                      <span className={`badge ${trigger.enabled ? "badge-success" : "badge-neutral"}`}>
                        {trigger.enabled ? "enabled" : "disabled"}
                      </span>
                    </td>
                    <td>{trigger.nextCheckAt ?? "-"}</td>
                    <td>{trigger.lastFireId ?? "-"}</td>
                    <td>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={working === trigger.triggerId}
                          onClick={() => runTest(trigger.triggerId)}
                        >
                          <Play size={14} /> Test
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={working === trigger.triggerId}
                          onClick={() => toggleTrigger(trigger.triggerId, !trigger.enabled)}
                        >
                          {trigger.enabled ? "Disable" : "Enable"}
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => editTrigger(trigger.triggerId)}>
                          Edit
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => loadHistory(trigger.triggerId)}>
                          History
                        </button>
                        {trigger.sessionMode === "reuse_provider_session" && (
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={working === trigger.triggerId}
                            onClick={() => resetSessionBindings(trigger.triggerId)}
                          >
                            <RotateCcw size={14} /> Reset Session
                          </button>
                        )}
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={working === trigger.triggerId}
                          onClick={() => deleteTrigger(trigger.triggerId)}
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {historyTriggerId && (
        <div className="card">
          <div className="card-header">
            <h3>History: {historyTriggerId}</h3>
          </div>
          {historyError && <div className="error-message">{historyError}</div>}
          {sessionBindings.length > 0 && (
            <div className="table-container" style={{ marginBottom: "12px" }}>
              <table>
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Provider</th>
                    <th>Provider Session</th>
                    <th>Active Run</th>
                    <th>Last Run</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionBindings.map((binding) => (
                    <tr key={binding.bindingId}>
                      <td>{binding.role}</td>
                      <td>{binding.provider}</td>
                      <td>
                        <code>{binding.providerSessionId ?? "-"}</code>
                      </td>
                      <td>{binding.activeWorkflowRunId ?? "-"}</td>
                      <td>{binding.lastWorkflowRunId ?? "-"}</td>
                      <td>{binding.updatedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {historyLoading ? (
            <div className="empty-state" style={{ padding: "24px 12px" }}>
              <div className="loading-spinner" style={{ margin: "0 auto" }} />
            </div>
          ) : history.length === 0 ? (
            <div className="empty-state" style={{ padding: "24px 12px" }}>
              <p>No trigger fire history.</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Fire ID</th>
                    <th>Status</th>
                    <th>Workflow Run</th>
                    <th>Reason</th>
                    <th>Error</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item) => (
                    <tr key={item.fireId}>
                      <td>
                        <code>{item.fireId}</code>
                      </td>
                      <td>{item.status}</td>
                      <td>
                        {item.workflowRunId ? (
                          <a href={`#/workflow/runs/${item.workflowRunId}/overview`}>{item.workflowRunId}</a>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>{item.reason ?? item.completionVerdict?.summary ?? "-"}</td>
                      <td>{item.error ?? "-"}</td>
                      <td>{item.startedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
