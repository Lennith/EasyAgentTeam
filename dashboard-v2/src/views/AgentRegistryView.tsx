import { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import { useSettings } from "@/hooks/useSettings";
import type { AgentDefinition, AgentTemplateDefinition } from "@/types";
import { agentApi, templateApi } from "@/services/api";
import * as mockData from "@/mock/data";
import { Plus, Save, Trash2, Loader, Edit, Copy, Cpu } from "lucide-react";

const CLI_TOOL_OPTIONS = [
  { value: "", label: "Default (Project Setting)" },
  { value: "codex", label: "Codex" },
  { value: "trae", label: "Trae" },
  { value: "minimax", label: "MiniMax" },
];

export function AgentRegistryView() {
  const t = useTranslation();
  const { settings } = useSettings();
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [templates, setTemplates] = useState<AgentTemplateDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editDefaultCliTool, setEditDefaultCliTool] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [newAgentId, setNewAgentId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newDefaultCliTool, setNewDefaultCliTool] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  useEffect(() => {
    let closed = false;
    async function load() {
      if (settings.useMockData) {
        if (!closed) {
          setAgents(mockData.mockAgents);
          setTemplates([
            ...(mockData.mockAgentTemplates.builtInItems ?? []),
            ...(mockData.mockAgentTemplates.customItems ?? []),
          ]);
          setError(null);
          setLoading(false);
        }
        return;
      }
      
      try {
        const [agentData, templateData] = await Promise.all([
          agentApi.list(),
          templateApi.list(),
        ]);
        if (!closed) {
          setAgents(agentData.items ?? []);
          setTemplates([
            ...(templateData.builtInItems ?? []),
            ...(templateData.customItems ?? []),
          ]);
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load agents");
        }
      } finally {
        if (!closed) setLoading(false);
      }
    }
    load();
    return () => { closed = true; };
  }, [settings.useMockData]);

  const startEdit = (agent: AgentDefinition) => {
    setEditingId(agent.agentId);
    setEditDisplayName(agent.displayName);
    setEditPrompt(agent.prompt);
    setEditDefaultCliTool(agent.defaultCliTool ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDisplayName("");
    setEditPrompt("");
    setEditDefaultCliTool("");
  };

  const saveEdit = async (agentId: string) => {
    if (settings.useMockData) {
      setAgents(agents.map((a) => 
        a.agentId === agentId 
          ? { ...a, displayName: editDisplayName, prompt: editPrompt, defaultCliTool: editDefaultCliTool as "codex" | "trae" | "minimax" | undefined || undefined }
          : a
      ));
      cancelEdit();
      return;
    }
    
    try {
      setSaving(true);
      await agentApi.update(agentId, {
        display_name: editDisplayName,
        prompt: editPrompt,
        default_cli_tool: editDefaultCliTool as "codex" | "trae" | "minimax" | undefined || undefined,
      });
      setAgents(agents.map((a) => 
        a.agentId === agentId 
          ? { ...a, displayName: editDisplayName, prompt: editPrompt, defaultCliTool: editDefaultCliTool as "codex" | "trae" | "minimax" | undefined || undefined }
          : a
      ));
      cancelEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const deleteAgent = async (agentId: string) => {
    if (!window.confirm(`Delete agent '${agentId}'?`)) return;
    
    if (settings.useMockData) {
      setAgents(agents.filter((a) => a.agentId !== agentId));
      return;
    }
    
    try {
      await agentApi.delete(agentId);
      setAgents(agents.filter((a) => a.agentId !== agentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const createAgent = async () => {
    if (settings.useMockData) {
      const newAgent: AgentDefinition = {
        agentId: newAgentId,
        displayName: newDisplayName,
        prompt: newPrompt,
        updatedAt: new Date().toISOString(),
        defaultCliTool: newDefaultCliTool as "codex" | "trae" | "minimax" | undefined || undefined,
      };
      setAgents([...agents, newAgent]);
      setShowNew(false);
      setNewAgentId("");
      setNewDisplayName("");
      setNewPrompt("");
      setNewDefaultCliTool("");
      setSelectedTemplateId("");
      return;
    }
    
    try {
      setSaving(true);
      await agentApi.create({
        agent_id: newAgentId,
        display_name: newDisplayName,
        prompt: newPrompt,
        default_cli_tool: newDefaultCliTool as "codex" | "trae" | "minimax" | undefined || undefined,
      });
      const data = await agentApi.list();
      setAgents(data.items ?? []);
      setShowNew(false);
      setNewAgentId("");
      setNewDisplayName("");
      setNewPrompt("");
      setNewDefaultCliTool("");
      setSelectedTemplateId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  };

  const applyTemplate = (templateId: string) => {
    const template = templates.find((t) => t.templateId === templateId);
    if (template) {
      setNewPrompt(template.prompt);
      if (!newDisplayName) {
        setNewDisplayName(template.displayName);
      }
    }
  };

  const copyFromAgent = (agent: AgentDefinition) => {
    setNewPrompt(agent.prompt);
    setNewDisplayName(agent.displayName + " (Copy)");
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.agentRegistry}</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>{t.loadingAgentRegistry}</p>
        </div>
      </section>
    );
  }

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.agentRegistry}</h1>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Plus size={16} /> {t.newAgent}
        </button>
      </div>

      {error && <div className="error-message" style={{ flexShrink: 0 }}>{error}</div>}

      {showNew && (
        <div className="card" style={{ flexShrink: 0 }}>
          <div className="card-header">
            <h3>{t.newAgent}</h3>
          </div>
          
          <div style={{ 
            marginBottom: "16px", 
            padding: "12px", 
            background: "var(--bg-elevated)", 
            borderRadius: "8px" 
          }}>
            <div style={{ marginBottom: "8px", fontSize: "13px", fontWeight: 500 }}>
              Apply Template (Optional)
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <select 
                value={selectedTemplateId}
                onChange={(e) => {
                  setSelectedTemplateId(e.target.value);
                  if (e.target.value) {
                    applyTemplate(e.target.value);
                  }
                }}
                style={{ flex: 1, minWidth: "200px" }}
              >
                <option value="">-- Select a template --</option>
                {templates.map((tpl) => (
                  <option key={tpl.templateId} value={tpl.templateId}>
                    {tpl.displayName} ({tpl.templateId})
                  </option>
                ))}
              </select>
              {selectedTemplateId && (
                <button 
                  className="btn btn-secondary btn-sm"
                  onClick={() => applyTemplate(selectedTemplateId)}
                >
                  <Copy size={12} /> Apply
                </button>
              )}
            </div>
          </div>

          <div className="form-group">
            <label>{t.agentId} *</label>
            <input value={newAgentId} onChange={(e) => setNewAgentId(e.target.value)} placeholder="e.g., backend_dev, frontend_dev" />
          </div>
          <div className="form-group">
            <label>{t.displayName} *</label>
            <input value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} placeholder="Display name for this agent" />
          </div>
          <div className="form-group">
            <label>{t.prompt}</label>
            <textarea 
              value={newPrompt} 
              onChange={(e) => setNewPrompt(e.target.value)} 
              style={{ minHeight: "200px" }}
              placeholder="Enter the agent's system prompt..."
            />
          </div>
          <div className="form-group">
            <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Cpu size={14} />
              Default CLI Tool
            </label>
            <select
              value={newDefaultCliTool}
              onChange={(e) => setNewDefaultCliTool(e.target.value)}
            >
              {CLI_TOOL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
              Override project-level tool setting for this agent
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="btn btn-primary" onClick={createAgent} disabled={saving || !newAgentId || !newDisplayName}>
              {saving ? <Loader size={14} className="loading-spinner" /> : <Plus size={14} />}
              {t.create}
            </button>
            <button className="btn btn-secondary" onClick={() => {
              setShowNew(false);
              setNewAgentId("");
              setNewDisplayName("");
              setNewPrompt("");
              setSelectedTemplateId("");
            }}>
              {t.cancel}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "12px", flex: 1, minHeight: 0, overflow: "auto", paddingRight: "4px" }}>
        {agents.map((agent) => (
          <div key={agent.agentId} className="card" style={{ flexShrink: 0 }}>
            {editingId === agent.agentId ? (
              <>
                <div className="form-group">
                  <label>{t.displayName}</label>
                  <input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>{t.prompt}</label>
                  <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} style={{ minHeight: "150px" }} />
                </div>
                <div className="form-group">
                  <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Cpu size={14} />
                    Default CLI Tool
                  </label>
                  <select
                    value={editDefaultCliTool}
                    onChange={(e) => setEditDefaultCliTool(e.target.value)}
                  >
                    {CLI_TOOL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="btn btn-primary" onClick={() => saveEdit(agent.agentId)} disabled={saving}>
                    {saving ? <Loader size={14} className="loading-spinner" /> : <Save size={14} />}
                    {t.save}
                  </button>
                  <button className="btn btn-secondary" onClick={cancelEdit}>
                    {t.cancel}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="card-header">
                  <div>
                    <h3>{agent.displayName}</h3>
                    <span className="badge badge-neutral">{agent.agentId}</span>
                    {agent.defaultCliTool && (
                      <span className="badge badge-primary" style={{ marginLeft: "8px" }}>
                        {agent.defaultCliTool}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button 
                      className="btn btn-secondary btn-sm" 
                      onClick={() => {
                        setShowNew(true);
                        copyFromAgent(agent);
                      }}
                      title="Create new agent from this"
                    >
                      <Copy size={14} />
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => startEdit(agent)}>
                      <Edit size={14} /> Edit
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteAgent(agent.agentId)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <pre style={{ 
                  margin: 0, 
                  padding: "12px", 
                  background: "var(--bg-elevated)", 
                  borderRadius: "6px",
                  fontSize: "12px",
                  maxHeight: "200px",
                  overflow: "auto"
                }}>
                  {agent.prompt}
                </pre>
                <div style={{ marginTop: "8px", fontSize: "12px", color: "var(--text-muted)" }}>
                  {t.updatedAt}: {new Date(agent.updatedAt).toLocaleString()}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {agents.length === 0 && !showNew && (
        <div className="empty-state">
          <p>{t.noAgents}</p>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            <Plus size={16} /> {t.newAgent}
          </button>
        </div>
      )}
    </section>
  );
}
