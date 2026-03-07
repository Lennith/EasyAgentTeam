import { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import type { AgentTemplateDefinition } from "@/types";
import { templateApi } from "@/services/api";
import { Plus, Save, Trash2, Loader, Edit, Copy } from "lucide-react";

export function AgentTemplatesView() {
  const t = useTranslation();
  const [builtInTemplates, setBuiltInTemplates] = useState<AgentTemplateDefinition[]>([]);
  const [customTemplates, setCustomTemplates] = useState<AgentTemplateDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [newTemplateId, setNewTemplateId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");

  useEffect(() => {
    let closed = false;
    async function load() {
      try {
        const data = await templateApi.list();
        if (!closed) {
          setBuiltInTemplates(data.builtInItems ?? []);
          setCustomTemplates(data.customItems ?? []);
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load templates");
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

  const startEdit = (template: AgentTemplateDefinition) => {
    setEditingId(template.templateId);
    setEditDisplayName(template.displayName);
    setEditPrompt(template.prompt);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDisplayName("");
    setEditPrompt("");
  };

  const saveEdit = async (templateId: string) => {
    try {
      setSaving(true);
      await templateApi.update(templateId, {
        display_name: editDisplayName,
        prompt: editPrompt
      });
      setCustomTemplates(
        customTemplates.map((t) =>
          t.templateId === templateId ? { ...t, displayName: editDisplayName, prompt: editPrompt } : t
        )
      );
      cancelEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async (templateId: string) => {
    if (!window.confirm(`Delete template '${templateId}'?`)) return;
    try {
      await templateApi.delete(templateId);
      setCustomTemplates(customTemplates.filter((t) => t.templateId !== templateId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const createTemplate = async () => {
    try {
      setSaving(true);
      await templateApi.create({
        template_id: newTemplateId,
        display_name: newDisplayName,
        prompt: newPrompt
      });
      const data = await templateApi.list();
      setCustomTemplates(data.customItems ?? []);
      setShowNew(false);
      setNewTemplateId("");
      setNewDisplayName("");
      setNewPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  };

  const copyFromTemplate = (template: AgentTemplateDefinition) => {
    setNewPrompt(template.prompt);
    setNewDisplayName(template.displayName + " (Copy)");
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.agentTemplates}</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>{t.loadingAgentTemplates}</p>
        </div>
      </section>
    );
  }

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.agentTemplates}</h1>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Plus size={16} /> {t.newTemplate}
        </button>
      </div>

      {error && (
        <div className="error-message" style={{ flexShrink: 0 }}>
          {error}
        </div>
      )}

      {showNew && (
        <div className="card" style={{ flexShrink: 0 }}>
          <div className="card-header">
            <h3>{t.newTemplate}</h3>
          </div>
          <div className="form-group">
            <label>{t.templateId} *</label>
            <input
              value={newTemplateId}
              onChange={(e) => setNewTemplateId(e.target.value)}
              placeholder="e.g., custom_dev"
            />
          </div>
          <div className="form-group">
            <label>{t.displayName} *</label>
            <input
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="Display name"
            />
          </div>
          <div className="form-group">
            <label>{t.prompt}</label>
            <textarea
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              style={{ minHeight: "200px" }}
              placeholder="Enter the template prompt..."
            />
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              className="btn btn-primary"
              onClick={createTemplate}
              disabled={saving || !newTemplateId || !newDisplayName}
            >
              {saving ? <Loader size={14} className="loading-spinner" /> : <Plus size={14} />}
              {t.create}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setShowNew(false);
                setNewTemplateId("");
                setNewDisplayName("");
                setNewPrompt("");
              }}
            >
              {t.cancel}
            </button>
          </div>
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          paddingRight: "4px",
          display: "flex",
          flexDirection: "column",
          gap: "12px"
        }}
      >
        <div className="card" style={{ flexShrink: 0 }}>
          <div className="card-header">
            <h3>Built-in Templates</h3>
            <span className="badge badge-neutral">{builtInTemplates.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {builtInTemplates.map((template) => (
              <div
                key={template.templateId}
                style={{
                  padding: "12px",
                  background: "var(--bg-elevated)",
                  borderRadius: "8px"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{template.displayName}</span>
                    <span className="badge badge-neutral" style={{ marginLeft: "8px" }}>
                      {template.templateId}
                    </span>
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setShowNew(true);
                      copyFromTemplate(template);
                    }}
                  >
                    <Copy size={12} /> Copy
                  </button>
                </div>
                <pre
                  style={{
                    margin: 0,
                    fontSize: "11px",
                    maxHeight: "100px",
                    overflow: "auto",
                    color: "var(--text-muted)"
                  }}
                >
                  {template.prompt.slice(0, 500)}...
                </pre>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ flexShrink: 0 }}>
          <div className="card-header">
            <h3>Custom Templates</h3>
            <span className="badge badge-neutral">{customTemplates.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {customTemplates.map((template) => (
              <div
                key={template.templateId}
                style={{
                  padding: "12px",
                  background: "var(--bg-elevated)",
                  borderRadius: "8px"
                }}
              >
                {editingId === template.templateId ? (
                  <>
                    <div className="form-group">
                      <label>{t.displayName}</label>
                      <input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label>{t.prompt}</label>
                      <textarea
                        value={editPrompt}
                        onChange={(e) => setEditPrompt(e.target.value)}
                        style={{ minHeight: "150px" }}
                      />
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        className="btn btn-primary"
                        onClick={() => saveEdit(template.templateId)}
                        disabled={saving}
                      >
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
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                      <div>
                        <span style={{ fontWeight: 600 }}>{template.displayName}</span>
                        <span className="badge badge-neutral" style={{ marginLeft: "8px" }}>
                          {template.templateId}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setShowNew(true);
                            copyFromTemplate(template);
                          }}
                        >
                          <Copy size={12} />
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => startEdit(template)}>
                          <Edit size={12} />
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => deleteTemplate(template.templateId)}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        fontSize: "11px",
                        maxHeight: "100px",
                        overflow: "auto",
                        color: "var(--text-muted)"
                      }}
                    >
                      {template.prompt}
                    </pre>
                  </>
                )}
              </div>
            ))}
            {customTemplates.length === 0 && (
              <div className="empty-state" style={{ padding: "16px" }}>
                <p>{t.noData}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
