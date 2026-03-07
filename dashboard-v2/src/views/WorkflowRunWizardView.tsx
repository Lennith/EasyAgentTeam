import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Plus, Trash2 } from "lucide-react";
import { workflowApi } from "@/services/api";
import type { WorkflowTemplateRecord } from "@/types";

interface KeyValueRow {
  key: string;
  value: string;
}

function parseTemplateFromHashQuery(): string | undefined {
  const hash = window.location.hash ?? "";
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) {
    return undefined;
  }
  const query = hash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  const value = params.get("template");
  return value || undefined;
}

function rowsToMap(rows: KeyValueRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

export function WorkflowRunWizardView() {
  const [step, setStep] = useState(1);
  const [templates, setTemplates] = useState<WorkflowTemplateRecord[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(parseTemplateFromHashQuery() ?? "");
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplateRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [workspacePath, setWorkspacePath] = useState("");

  const [runId, setRunId] = useState("");
  const [runName, setRunName] = useState("");
  const [description, setDescription] = useState("");
  const [variableRows, setVariableRows] = useState<KeyValueRow[]>([{ key: "", value: "" }]);
  const [overrideRows, setOverrideRows] = useState<KeyValueRow[]>([]);

  useEffect(() => {
    let closed = false;
    async function load() {
      setLoading(true);
      try {
        const templatePayload = await workflowApi.listTemplates();
        if (closed) {
          return;
        }
        setTemplates(templatePayload.items ?? []);
        setSelectedTemplateId((prev) => prev || templatePayload.items?.[0]?.templateId || "");
        setError(null);
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load wizard options");
        }
      } finally {
        if (!closed) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      closed = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedTemplateId) {
      setSelectedTemplate(null);
      return;
    }
    let closed = false;
    async function loadTemplate() {
      try {
        const template = await workflowApi.getTemplate(selectedTemplateId);
        if (closed) {
          return;
        }
        setSelectedTemplate(template);
        setOverrideRows(template.tasks.map((task) => ({ key: task.taskId, value: task.title })));
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load selected template");
        }
      }
    }
    loadTemplate();
    return () => {
      closed = true;
    };
  }, [selectedTemplateId]);

  const canGoStep2 = selectedTemplateId.length > 0;
  const canGoStep3 = workspacePath.trim().length > 0;
  const variableMap = useMemo(() => rowsToMap(variableRows), [variableRows]);
  const overrideMap = useMemo(() => rowsToMap(overrideRows), [overrideRows]);

  const createRun = async () => {
    if (!selectedTemplateId) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const payload = await workflowApi.createRun({
        template_id: selectedTemplateId,
        run_id: runId.trim() || undefined,
        name: runName.trim() || undefined,
        description: description.trim() || undefined,
        workspace_path: workspacePath.trim(),
        variables: variableMap,
        task_overrides: overrideMap
      });
      window.location.hash = `#/workflow/runs/${payload.runId}/overview`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workflow run");
    } finally {
      setCreating(false);
    }
  };

  const updateRow = (
    rows: KeyValueRow[],
    setRows: (rows: KeyValueRow[]) => void,
    index: number,
    patch: Partial<KeyValueRow>
  ) => {
    const next = [...rows];
    next[index] = { ...next[index], ...patch };
    setRows(next);
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>Create Workflow Run</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>Loading wizard options...</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>Create Workflow Run</h1>
        <a className="btn btn-secondary" href="#/workflow">
          <ArrowLeft size={14} /> Back to Runs
        </a>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="card">
        <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
          {[1, 2, 3].map((value) => (
            <button
              key={value}
              className={`btn ${step === value ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setStep(value)}
            >
              Step {value}
            </button>
          ))}
        </div>

        {step === 1 && (
          <div>
            <h3 style={{ marginBottom: "12px" }}>Step 1: Choose Template</h3>
            <div className="form-group">
              <label>Template</label>
              <select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}>
                <option value="">Select a workflow template...</option>
                {templates.map((template) => (
                  <option key={template.templateId} value={template.templateId}>
                    {template.name} ({template.templateId})
                  </option>
                ))}
              </select>
            </div>

            {selectedTemplate && (
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div>
                  <strong>Name:</strong> {selectedTemplate.name}
                </div>
                <div>
                  <strong>Tasks:</strong> {selectedTemplate.tasks.length}
                </div>
                <div>
                  <strong>Roles:</strong>{" "}
                  {Array.from(new Set(selectedTemplate.tasks.map((task) => task.ownerRole))).join(", ") || "-"}
                </div>
              </div>
            )}

            <div style={{ marginTop: "16px" }}>
              <button className="btn btn-primary" disabled={!canGoStep2} onClick={() => setStep(2)}>
                Next <ArrowRight size={14} />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 style={{ marginBottom: "12px" }}>Step 2: Workspace</h3>
            <div className="form-group">
              <label>workspace_path *</label>
              <input
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="D:\\AgentWorkSpace\\YourWorkspace"
              />
              <p style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-muted)" }}>
                Workflow run now accepts workspace path only.
              </p>
            </div>

            <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
              <button className="btn btn-secondary" onClick={() => setStep(1)}>
                <ArrowLeft size={14} /> Prev
              </button>
              <button className="btn btn-primary" disabled={!canGoStep3} onClick={() => setStep(3)}>
                Next <ArrowRight size={14} />
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 style={{ marginBottom: "12px" }}>Step 3: Variables & Overrides</h3>
            <div className="grid grid-2">
              <div className="form-group">
                <label>run_id (optional)</label>
                <input value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="workflow_run_001" />
              </div>
              <div className="form-group">
                <label>name (optional)</label>
                <input value={runName} onChange={(e) => setRunName(e.target.value)} placeholder="My workflow run" />
              </div>
            </div>
            <div className="form-group">
              <label>description (optional)</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Run description"
              />
            </div>

            <div className="card" style={{ padding: "12px", marginTop: "8px" }}>
              <div className="card-header">
                <h3>variables</h3>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setVariableRows((prev) => [...prev, { key: "", value: "" }])}
                >
                  <Plus size={14} /> Add
                </button>
              </div>
              {variableRows.map((row, index) => (
                <div
                  key={`var-${index}`}
                  style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "8px", marginBottom: "8px" }}
                >
                  <input
                    value={row.key}
                    placeholder="key"
                    onChange={(e) => updateRow(variableRows, setVariableRows, index, { key: e.target.value })}
                  />
                  <input
                    value={row.value}
                    placeholder="value"
                    onChange={(e) => updateRow(variableRows, setVariableRows, index, { value: e.target.value })}
                  />
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => setVariableRows((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <div className="card" style={{ padding: "12px", marginTop: "8px" }}>
              <div className="card-header">
                <h3>task_overrides</h3>
              </div>
              {overrideRows.length === 0 && (
                <p style={{ color: "var(--text-muted)" }}>No tasks loaded from template.</p>
              )}
              {overrideRows.map((row, index) => (
                <div
                  key={`override-${index}`}
                  style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "8px", marginBottom: "8px" }}
                >
                  <input value={row.key} readOnly />
                  <input
                    value={row.value}
                    onChange={(e) => updateRow(overrideRows, setOverrideRows, index, { value: e.target.value })}
                  />
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
              <button className="btn btn-secondary" onClick={() => setStep(2)}>
                <ArrowLeft size={14} /> Prev
              </button>
              <button className="btn btn-primary" disabled={creating || !selectedTemplateId} onClick={createRun}>
                <Check size={14} /> {creating ? "Creating..." : "Create Run"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
