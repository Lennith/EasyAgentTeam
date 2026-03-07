import { useMemo, useState } from "react";
import { RefreshCw, Trash2, Pencil, Play, Plus, Search } from "lucide-react";
import { workflowApi } from "@/services/api";
import { useWorkflowTemplates } from "@/hooks/useWorkflowData";

export function WorkflowTemplatesView() {
  const { items, loading, error, reload } = useWorkflowTemplates();
  const [keyword, setKeyword] = useState("");
  const [workingId, setWorkingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) {
      return items;
    }
    return items.filter((item) => {
      return item.templateId.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle);
    });
  }, [items, keyword]);

  const onDelete = async (templateId: string) => {
    if (!window.confirm(`Delete workflow template "${templateId}"?`)) {
      return;
    }
    setWorkingId(templateId);
    try {
      await workflowApi.deleteTemplate(templateId);
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete template");
    } finally {
      setWorkingId(null);
    }
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>Workflow Templates</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>Loading templates...</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>Workflow Templates</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-secondary" onClick={reload}>
            <RefreshCw size={14} /> Refresh
          </button>
          <a className="btn btn-primary" href="#/workflow/templates/new">
            <Plus size={14} /> Create Template
          </a>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="card">
        <div className="form-group" style={{ marginBottom: "12px" }}>
          <label>Search</label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Search size={14} style={{ color: "var(--text-muted)" }} />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Search by template_id or name"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: "32px 12px" }}>
            <p>No templates found.</p>
            <a className="btn btn-primary" href="#/workflow/templates/new">
              Create the first template
            </a>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Template ID</th>
                  <th>Name</th>
                  <th>Tasks</th>
                  <th>Updated At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.templateId}>
                    <td>
                      <code>{item.templateId}</code>
                    </td>
                    <td>{item.name}</td>
                    <td>{item.tasks.length}</td>
                    <td>{item.updatedAt}</td>
                    <td>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <a className="btn btn-secondary btn-sm" href={`#/workflow/templates/${item.templateId}/edit`}>
                          <Pencil size={14} /> Edit
                        </a>
                        <a
                          className="btn btn-secondary btn-sm"
                          href={`#/workflow/runs/new?template=${encodeURIComponent(item.templateId)}`}
                        >
                          <Play size={14} /> Create Run
                        </a>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => onDelete(item.templateId)}
                          disabled={workingId === item.templateId}
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
    </section>
  );
}
