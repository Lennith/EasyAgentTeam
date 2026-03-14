import { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import { useSettings } from "@/hooks/useSettings";
import { skillApi, skillListApi } from "@/services/api";
import type { SkillDefinition, SkillListDefinition } from "@/types";
import * as mockData from "@/mock/data";
import { Edit, Loader, Plus, Save, Search, Trash2, X } from "lucide-react";

function skillMatchesQuery(skill: SkillDefinition, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const haystack = [skill.name, skill.skillId, skill.description ?? ""].join(" ").toLowerCase();
  return haystack.includes(normalizedQuery);
}

function readSkillLabel(skill: SkillDefinition): string {
  return `${skill.name} (${skill.skillId})`;
}

interface EditState {
  listId: string;
  displayName: string;
  description: string;
  includeAll: boolean;
  skillIds: string[];
}

interface SkillPickerProps {
  skills: SkillDefinition[];
  selectedSkillIds: string[];
  searchValue: string;
  onSearchChange: (value: string) => void;
  onAdd: (skillId: string) => void;
  onRemove: (skillId: string) => void;
  disabled: boolean;
}

function SkillPicker({
  skills,
  selectedSkillIds,
  searchValue,
  onSearchChange,
  onAdd,
  onRemove,
  disabled
}: SkillPickerProps) {
  const selectedSet = new Set(selectedSkillIds);
  const selectedSkills = selectedSkillIds
    .map((skillId) => skills.find((item) => item.skillId === skillId))
    .filter((item): item is SkillDefinition => !!item);
  const missingSkillIds = selectedSkillIds.filter((skillId) => !skills.some((item) => item.skillId === skillId));
  const availableSkills = skills.filter(
    (skill) => !selectedSet.has(skill.skillId) && skillMatchesQuery(skill, searchValue)
  );

  return (
    <div className="form-group">
      <label>Explicit skills</label>

      <div style={{ marginBottom: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
        <Search size={14} color="var(--text-muted)" />
        <input
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search library by name, id, or description"
          disabled={disabled}
        />
      </div>

      <div style={{ marginBottom: "8px", fontSize: "12px", color: "var(--text-muted)" }}>
        {disabled
          ? "include_all is enabled, explicit skills are optional."
          : "Click + to add from library, click x to remove selected skills."}
      </div>

      <div style={{ marginBottom: "10px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
        {selectedSkills.length === 0 && missingSkillIds.length === 0 ? (
          <span className="badge badge-neutral">No explicit skills selected</span>
        ) : (
          <>
            {selectedSkills.map((skill) => (
              <span
                key={skill.skillId}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 8px",
                  borderRadius: "999px",
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-color)",
                  fontSize: "12px"
                }}
              >
                {readSkillLabel(skill)}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ padding: "2px 6px" }}
                  onClick={() => onRemove(skill.skillId)}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {missingSkillIds.map((skillId) => (
              <span key={skillId} className="badge badge-warning">
                missing: {skillId}
              </span>
            ))}
          </>
        )}
      </div>

      <div
        style={{
          border: "1px solid var(--border-color)",
          borderRadius: "8px",
          maxHeight: "180px",
          overflowY: "auto",
          padding: "8px",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          opacity: disabled ? 0.6 : 1
        }}
      >
        {availableSkills.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>No matching skills in library.</div>
        ) : (
          availableSkills.map((skill) => (
            <div
              key={skill.skillId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                padding: "6px 8px",
                background: "var(--bg-elevated)",
                borderRadius: "6px"
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "13px", fontWeight: 500 }}>{skill.name}</div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{skill.skillId}</div>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onAdd(skill.skillId)}
                disabled={disabled}
              >
                <Plus size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function SkillListsView() {
  const t = useTranslation();
  const { settings } = useSettings();
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [lists, setLists] = useState<SkillListDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);

  const [newListId, setNewListId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newIncludeAll, setNewIncludeAll] = useState(false);
  const [newSkillIds, setNewSkillIds] = useState<string[]>([]);
  const [newSkillSearch, setNewSkillSearch] = useState("");
  const [editSkillSearch, setEditSkillSearch] = useState("");

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (settings.useMockData) {
        setSkills(mockData.mockSkills);
        setLists(mockData.mockSkillLists);
        return;
      }
      const [skillResult, listResult] = await Promise.all([skillApi.list(), skillListApi.list()]);
      setSkills(skillResult.items ?? []);
      setLists(listResult.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skill lists");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [settings.useMockData]);

  const resetCreateForm = () => {
    setNewListId("");
    setNewDisplayName("");
    setNewDescription("");
    setNewIncludeAll(false);
    setNewSkillIds([]);
    setNewSkillSearch("");
  };

  const addCreateSkill = (skillId: string) => {
    setNewSkillIds((prev) => (prev.includes(skillId) ? prev : [...prev, skillId]));
  };

  const removeCreateSkill = (skillId: string) => {
    setNewSkillIds((prev) => prev.filter((item) => item !== skillId));
  };

  const handleCreate = async () => {
    if (!newListId.trim()) {
      setError("list_id is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (settings.useMockData) {
        const now = new Date().toISOString();
        const created: SkillListDefinition = {
          schemaVersion: "1.0",
          listId: newListId.trim(),
          displayName: newDisplayName.trim() || newListId.trim(),
          description: newDescription.trim() || undefined,
          includeAll: newIncludeAll,
          skillIds: newSkillIds,
          createdAt: now,
          updatedAt: now
        };
        setLists((prev) => [...prev, created].sort((a, b) => a.listId.localeCompare(b.listId)));
      } else {
        const created = await skillListApi.create({
          list_id: newListId.trim(),
          display_name: newDisplayName.trim() || undefined,
          description: newDescription.trim() || undefined,
          include_all: newIncludeAll,
          skill_ids: newSkillIds
        });
        setLists((prev) => [...prev, created].sort((a, b) => a.listId.localeCompare(b.listId)));
      }
      resetCreateForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill list");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (listId: string) => {
    if (!window.confirm(`Delete skill list '${listId}'?`)) {
      return;
    }
    try {
      if (!settings.useMockData) {
        await skillListApi.delete(listId);
      }
      setLists((prev) => prev.filter((item) => item.listId !== listId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete skill list");
    }
  };

  const startEdit = (list: SkillListDefinition) => {
    setEditing({
      listId: list.listId,
      displayName: list.displayName,
      description: list.description ?? "",
      includeAll: list.includeAll,
      skillIds: [...list.skillIds]
    });
    setEditSkillSearch("");
  };

  const addEditSkill = (skillId: string) => {
    setEditing((prev) => {
      if (!prev || prev.skillIds.includes(skillId)) {
        return prev;
      }
      return { ...prev, skillIds: [...prev.skillIds, skillId] };
    });
  };

  const removeEditSkill = (skillId: string) => {
    setEditing((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, skillIds: prev.skillIds.filter((item) => item !== skillId) };
    });
  };

  const saveEdit = async () => {
    if (!editing) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (settings.useMockData) {
        const now = new Date().toISOString();
        setLists((prev) =>
          prev.map((item) =>
            item.listId === editing.listId
              ? {
                  ...item,
                  displayName: editing.displayName.trim() || item.listId,
                  description: editing.description.trim() || undefined,
                  includeAll: editing.includeAll,
                  skillIds: editing.skillIds,
                  updatedAt: now
                }
              : item
          )
        );
      } else {
        const updated = await skillListApi.update(editing.listId, {
          display_name: editing.displayName.trim() || undefined,
          description: editing.description.trim() || null,
          include_all: editing.includeAll,
          skill_ids: editing.skillIds
        });
        setLists((prev) => prev.map((item) => (item.listId === updated.listId ? updated : item)));
      }
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update skill list");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>Skill Lists</h1>
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
        <h1>Skill Lists</h1>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="card">
        <div className="card-header">
          <h3>Create List</h3>
        </div>
        <div className="grid grid-2">
          <div className="form-group">
            <label>List ID *</label>
            <input value={newListId} onChange={(e) => setNewListId(e.target.value)} placeholder="default-core" />
          </div>
          <div className="form-group">
            <label>{t.displayName}</label>
            <input value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label>{t.description}</label>
          <textarea
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            style={{ minHeight: "80px" }}
          />
        </div>
        <div className="form-group">
          <label>Scope</label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <input type="checkbox" checked={newIncludeAll} onChange={(e) => setNewIncludeAll(e.target.checked)} />
            include_all
          </label>
          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Include all imported skills dynamically. Explicit skills below can still be added manually.
          </div>
        </div>
        <SkillPicker
          skills={skills}
          selectedSkillIds={newSkillIds}
          searchValue={newSkillSearch}
          onSearchChange={setNewSkillSearch}
          onAdd={addCreateSkill}
          onRemove={removeCreateSkill}
          disabled={false}
        />
        <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
          {saving ? <Loader size={14} className="loading-spinner" /> : <Plus size={14} />}
          {t.create}
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Lists ({lists.length})</h3>
        </div>
        {lists.length === 0 ? (
          <div className="empty-state">
            <p>No skill list created.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {lists.map((list) => {
              const isEditing = editing?.listId === list.listId;
              return (
                <div
                  key={list.listId}
                  style={{ background: "var(--bg-elevated)", borderRadius: "8px", padding: "12px" }}
                >
                  {isEditing && editing ? (
                    <>
                      <div className="form-group">
                        <label>{t.displayName}</label>
                        <input
                          value={editing.displayName}
                          onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>{t.description}</label>
                        <textarea
                          value={editing.description}
                          onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                          style={{ minHeight: "80px" }}
                        />
                      </div>
                      <div className="form-group">
                        <label>Scope</label>
                        <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                          <input
                            type="checkbox"
                            checked={editing.includeAll}
                            onChange={(e) => setEditing({ ...editing, includeAll: e.target.checked })}
                          />
                          include_all
                        </label>
                        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                          Include all imported skills dynamically. Explicit skills below can still be added manually.
                        </div>
                      </div>
                      <SkillPicker
                        skills={skills}
                        selectedSkillIds={editing.skillIds}
                        searchValue={editSkillSearch}
                        onSearchChange={setEditSkillSearch}
                        onAdd={addEditSkill}
                        onRemove={removeEditSkill}
                        disabled={false}
                      />
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={saving}>
                          {saving ? <Loader size={14} className="loading-spinner" /> : <Save size={14} />}
                          {t.save}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setEditing(null);
                            setEditSkillSearch("");
                          }}
                        >
                          <X size={14} />
                          {t.cancel}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{list.displayName}</div>
                          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{list.listId}</div>
                        </div>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => startEdit(list)}>
                            <Edit size={14} />
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(list.listId)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      {list.description && <div style={{ marginTop: "6px", fontSize: "13px" }}>{list.description}</div>}
                      <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        {list.includeAll && <span className="badge badge-primary">include_all</span>}
                        {list.skillIds.length === 0 ? (
                          <span className="badge badge-neutral">no explicit skills</span>
                        ) : (
                          list.skillIds.map((skillId) => (
                            <span key={skillId} className="badge badge-neutral">
                              {skillId}
                            </span>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
