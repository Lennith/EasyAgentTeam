import { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import { useSettings } from "@/hooks/useSettings";
import { skillApi } from "@/services/api";
import type { SkillDefinition } from "@/types";
import * as mockData from "@/mock/data";
import { Download, Loader, RefreshCw, Trash2 } from "lucide-react";

function normalizeSources(raw: string): string[] {
  const values = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(values));
}

export function SkillsLibraryView() {
  const t = useTranslation();
  const { settings } = useSettings();
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourcesInput, setSourcesInput] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importSummary, setImportSummary] = useState<string>("");

  const loadSkills = async () => {
    setLoading(true);
    setError(null);
    try {
      if (settings.useMockData) {
        setSkills(mockData.mockSkills);
        setImportWarnings([]);
        return;
      }
      const result = await skillApi.list();
      setSkills(result.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSkills();
  }, [settings.useMockData]);

  const handleImport = async () => {
    const sources = normalizeSources(sourcesInput);
    if (sources.length === 0) {
      setError("Please input at least one local path.");
      return;
    }
    setError(null);
    setImporting(true);
    setImportSummary("");
    setImportWarnings([]);
    try {
      if (settings.useMockData) {
        setImportSummary(`Imported ${sources.length} source path(s) in mock mode.`);
        return;
      }
      const result = await skillApi.import({ sources, recursive });
      setImportSummary(`Imported ${result.imported.length} skill package(s).`);
      setImportWarnings(result.warnings ?? []);
      const refreshed = await skillApi.list();
      setSkills(refreshed.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import skills");
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (skillId: string) => {
    if (!window.confirm(`Delete skill '${skillId}'?`)) {
      return;
    }
    try {
      if (settings.useMockData) {
        setSkills((prev) => prev.filter((item) => item.skillId !== skillId));
        return;
      }
      await skillApi.delete(skillId);
      setSkills((prev) => prev.filter((item) => item.skillId !== skillId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete skill");
    }
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>Skill Library</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>{t.loading}</p>
        </div>
      </section>
    );
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "12px", minHeight: 0, overflowY: "auto" }}>
      <div className="page-header">
        <h1>Skill Library</h1>
        <button className="btn btn-secondary" onClick={loadSkills}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Import Skills</h3>
        </div>
        <div className="form-group">
          <label>Sources (one local path per line)</label>
          <textarea
            value={sourcesInput}
            onChange={(e) => setSourcesInput(e.target.value)}
            style={{ minHeight: "120px" }}
            placeholder={"/path/to/skills/minimax-vision or C:\\Users\\name\\.config\\opencode\\skills\\minimax-vision"}
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          Recursively discover SKILL.md
        </label>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
            {importing ? <Loader size={14} className="loading-spinner" /> : <Download size={14} />}
            Import
          </button>
        </div>
        {importSummary && (
          <div style={{ marginTop: "10px", fontSize: "13px", color: "var(--accent-success)" }}>{importSummary}</div>
        )}
        {importWarnings.length > 0 && (
          <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--accent-warning)" }}>
            {importWarnings.map((warning) => (
              <div key={warning}>- {warning}</div>
            ))}
          </div>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="card">
        <div className="card-header">
          <h3>Library ({skills.length})</h3>
        </div>
        {skills.length === 0 ? (
          <div className="empty-state">
            <p>No skills imported.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {skills.map((skill) => (
              <div
                key={skill.skillId}
                style={{ background: "var(--bg-elevated)", borderRadius: "8px", padding: "12px" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{skill.name}</div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{skill.skillId}</div>
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(skill.skillId)}>
                    <Trash2 size={14} />
                  </button>
                </div>
                <div style={{ marginTop: "6px", fontSize: "13px" }}>{skill.description}</div>
                <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <span className="badge badge-neutral">compat: {skill.compatibility}</span>
                  <span className="badge badge-neutral">license: {skill.license}</span>
                  <span className="badge badge-neutral">source: {skill.sourceType}</span>
                </div>
                {!!skill.warnings?.length && (
                  <div style={{ marginTop: "8px", color: "var(--accent-warning)", fontSize: "12px" }}>
                    {skill.warnings.map((item) => (
                      <div key={item}>- {item}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
