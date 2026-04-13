import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/hooks/i18n";
import { teamApi, modelsApi } from "@/services/api";
import type { TeamRecord, AgentModelConfig, ModelInfo } from "@/types";
import { Save, Loader, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";

interface TeamEditorViewProps {
  teamId: string;
}

interface DiscussRoundsConfig {
  [from: string]: {
    [to: string]: number;
  };
}

export function TeamEditorView({ teamId }: TeamEditorViewProps) {
  const t = useTranslation();
  const [team, setTeam] = useState<TeamRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [routeTable, setRouteTable] = useState<Record<string, string[]>>({});
  const [taskAssignRouteTable, setTaskAssignRouteTable] = useState<Record<string, string[]>>({});
  const [discussRounds, setDiscussRounds] = useState<DiscussRoundsConfig>({});
  const [modelConfigs, setModelConfigs] = useState<Record<string, AgentModelConfig>>({});

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [newAgentId, setNewAgentId] = useState("");
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"members" | "message" | "task">("members");
  const initializedRef = useRef(false);

  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    loadTeam();
    loadModels();
  }, [teamId]);

  async function loadTeam() {
    setLoading(true);
    setError(null);
    try {
      const result = await teamApi.get(teamId);
      setTeam(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (team && !initializedRef.current) {
      initializedRef.current = true;
      setName(team.name);
      setDescription(team.description ?? "");
      setAgentIds(team.agentIds ?? []);
      setRouteTable(team.routeTable ?? {});
      setTaskAssignRouteTable(team.taskAssignRouteTable ?? {});
      setDiscussRounds(team.routeDiscussRounds ?? {});
      setModelConfigs(team.agentModelConfigs ?? {});
    }
  }, [team]);

  async function loadModels() {
    try {
      const res = await modelsApi.list(undefined, false);
      setAvailableModels(res.models ?? []);
    } catch (err) {
      console.error("Failed to load models:", err);
    }
  }

  function toggleExpand(agent: string) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) {
        next.delete(agent);
      } else {
        next.add(agent);
      }
      return next;
    });
  }

  function expandAll() {
    setExpandedAgents(new Set(agentIds));
  }

  function collapseAll() {
    setExpandedAgents(new Set());
  }

  function isRouteAllowed(from: string, to: string): boolean {
    return (routeTable[from] ?? []).includes(to);
  }

  function toggleRoute(from: string, to: string) {
    setRouteTable((prev) => {
      const current = prev[from] ?? [];
      const next = current.includes(to) ? current.filter((a) => a !== to) : [...current, to];
      return { ...prev, [from]: next };
    });
  }

  function isTaskAssignAllowed(from: string, to: string): boolean {
    return (taskAssignRouteTable[from] ?? []).includes(to);
  }

  function toggleTaskAssign(from: string, to: string) {
    setTaskAssignRouteTable((prev) => {
      const current = prev[from] ?? [];
      const next = current.includes(to) ? current.filter((a) => a !== to) : [...current, to];
      return { ...prev, [from]: next };
    });
  }

  function getDiscussRounds(from: string, to: string): number {
    return discussRounds[from]?.[to] ?? 20;
  }

  function setDiscussRoundsForRoute(from: string, to: string, rounds: number) {
    setDiscussRounds((prev) => {
      const next = { ...prev };
      if (!next[from]) next[from] = {};
      next[from][to] = Math.max(1, Math.min(500, rounds));
      return next;
    });
  }

  function addAgent() {
    if (newAgentId && !agentIds.includes(newAgentId)) {
      setAgentIds([...agentIds, newAgentId]);
      setNewAgentId("");
    }
  }

  function removeAgent(agent: string) {
    setAgentIds(agentIds.filter((a) => a !== agent));
    setRouteTable((prev) => {
      const next = { ...prev };
      delete next[agent];
      for (const key of Object.keys(next)) {
        next[key] = next[key].filter((a) => a !== agent);
      }
      return next;
    });
    setTaskAssignRouteTable((prev) => {
      const next = { ...prev };
      delete next[agent];
      for (const key of Object.keys(next)) {
        next[key] = next[key].filter((a) => a !== agent);
      }
      return next;
    });
    setDiscussRounds((prev) => {
      const next = { ...prev };
      delete next[agent];
      for (const key of Object.keys(next)) {
        delete next[key][agent];
      }
      return next;
    });
    setModelConfigs((prev) => {
      const next = { ...prev };
      delete next[agent];
      return next;
    });
  }

  function getTargetAgents(from: string): string[] {
    return routeTable[from] ?? [];
  }

  function getModelsForProvider(providerId: "codex" | "minimax"): ModelInfo[] {
    return availableModels.filter((m) => m.vendor === providerId);
  }

  async function onSave() {
    try {
      setSaving(true);
      setSaveError(null);
      setSuccess(null);

      await teamApi.update(teamId, {
        name,
        description: description || undefined,
        agent_ids: agentIds,
        route_table: routeTable,
        task_assign_route_table: taskAssignRouteTable,
        route_discuss_rounds: discussRounds,
        agent_model_configs: modelConfigs
      });

      setSuccess(t.teamUpdated);
      initializedRef.current = false;
      await loadTeam();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.loadingTeams}</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
        </div>
      </section>
    );
  }

  if (error || !team) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.error}</h1>
        </div>
        <div className="error-message">{error ?? "Team not found"}</div>
        <a href="#/teams" className="btn btn-secondary" style={{ marginTop: "16px" }}>
          Back to Teams
        </a>
      </section>
    );
  }

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{team.name}</h1>
        <span className="badge badge-neutral">{team.teamId}</span>
      </div>

      {saveError && (
        <div className="error-message" style={{ flexShrink: 0 }}>
          {saveError}
        </div>
      )}
      {success && (
        <div className="success-message" style={{ flexShrink: 0 }}>
          {success}
        </div>
      )}

      <div className="card" style={{ flexShrink: 0, marginBottom: "16px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <div>
            <label style={{ display: "block", fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>
              {t.teamName}
            </label>
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>
              {t.description}
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              style={{ width: "100%" }}
            />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexShrink: 0 }}>
        <button
          className={`btn ${activeTab === "members" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("members")}
        >
          {t.teamMembers}
        </button>
        <button
          className={`btn ${activeTab === "message" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("message")}
        >
          {t.messageRouting}
        </button>
        <button
          className={`btn ${activeTab === "task" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("task")}
        >
          {t.taskRouting}
        </button>
      </div>

      {activeTab === "members" && (
        <div className="card" style={{ flexShrink: 0 }}>
          <div className="card-header">
            <h3>{t.agents}</h3>
            <span className="badge badge-neutral">{agentIds.length}</span>
          </div>

          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
            <input
              value={newAgentId}
              onChange={(e) => setNewAgentId(e.target.value)}
              placeholder="New agent ID..."
              style={{ flex: 1 }}
            />
            <button className="btn btn-secondary" onClick={addAgent}>
              <Plus size={14} /> Add
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {agentIds.map((agent) => (
              <div
                key={agent}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "12px 16px",
                  background: "var(--bg-elevated)",
                  borderRadius: "8px"
                }}
              >
                <span style={{ flex: 1, fontWeight: 500 }}>{agent}</span>
                <select
                  value={modelConfigs[agent]?.provider_id ?? "minimax"}
                  onChange={(e) =>
                    setModelConfigs((prev) => ({
                      ...prev,
                      [agent]: { ...prev[agent], provider_id: e.target.value as "codex" | "minimax" }
                    }))
                  }
                  style={{ fontSize: "12px", padding: "4px 8px", width: "90px" }}
                >
                  <option value="minimax">MiniMax</option>
                  <option value="codex">Codex</option>
                </select>
                <select
                  value={modelConfigs[agent]?.model ?? ""}
                  onChange={(e) =>
                    setModelConfigs((prev) => ({
                      ...prev,
                      [agent]: { ...prev[agent], model: e.target.value }
                    }))
                  }
                  style={{ fontSize: "12px", padding: "4px 8px", width: "120px" }}
                >
                  <option value="">Model...</option>
                  {getModelsForProvider(modelConfigs[agent]?.provider_id ?? "minimax").map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.model.length > 16 ? m.model.slice(0, 16) + "..." : m.model}
                    </option>
                  ))}
                </select>
                <select
                  value={modelConfigs[agent]?.effort ?? "medium"}
                  onChange={(e) =>
                    setModelConfigs((prev) => ({
                      ...prev,
                      [agent]: { ...prev[agent], effort: e.target.value as "low" | "medium" | "high" }
                    }))
                  }
                  style={{ fontSize: "12px", padding: "4px 8px", width: "70px" }}
                >
                  <option value="low">{t.lowEffort}</option>
                  <option value="medium">{t.mediumEffort}</option>
                  <option value="high">{t.highEffort}</option>
                </select>
                <button className="btn btn-danger btn-sm" onClick={() => removeAgent(agent)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(activeTab === "message" || activeTab === "task") && (
        <div
          className="card"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
          }}
        >
          <div className="card-header" style={{ flexShrink: 0 }}>
            <h3>{activeTab === "message" ? t.messageRouting : t.taskRouting}</h3>
            <div style={{ display: "flex", gap: "8px" }}>
              <button className="btn btn-secondary btn-sm" onClick={expandAll}>
                Expand
              </button>
              <button className="btn btn-secondary btn-sm" onClick={collapseAll}>
                Collapse
              </button>
            </div>
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              paddingRight: "8px"
            }}
          >
            {agentIds.length === 0 ? (
              <div className="empty-state" style={{ padding: "24px" }}>
                <p>Add agents first to configure routing</p>
              </div>
            ) : (
              agentIds.map((from) => {
                const isExpanded = expandedAgents.has(from);
                const targets = getTargetAgents(from);

                return (
                  <div
                    key={from}
                    style={{
                      background: "var(--bg-elevated)",
                      borderRadius: "8px",
                      marginBottom: "8px"
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        padding: "12px 16px",
                        cursor: "pointer"
                      }}
                      onClick={() => toggleExpand(from)}
                    >
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span style={{ fontWeight: 600 }}>{from}</span>
                      <span className="badge badge-neutral" style={{ fontSize: "11px" }}>
                        {targets.length} targets
                      </span>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: "0 16px 16px", marginLeft: "28px" }}>
                        {activeTab === "message" && (
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 70px 70px",
                              gap: "6px",
                              marginBottom: "8px",
                              fontSize: "10px",
                              color: "var(--text-muted)",
                              fontWeight: 600
                            }}
                          >
                            <span>Target Agent</span>
                            <span style={{ textAlign: "center" }}>Rounds</span>
                            <span style={{ textAlign: "center" }}>Route</span>
                          </div>
                        )}

                        {activeTab === "task" && (
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 70px",
                              gap: "6px",
                              marginBottom: "8px",
                              fontSize: "10px",
                              color: "var(--text-muted)",
                              fontWeight: 600
                            }}
                          >
                            <span>Target Agent</span>
                            <span style={{ textAlign: "center" }}>Assign</span>
                          </div>
                        )}

                        {agentIds
                          .filter((to) => to !== from)
                          .map((to) => {
                            const routeAllowed = isRouteAllowed(from, to);
                            const assignAllowed = isTaskAssignAllowed(from, to);
                            const rounds = getDiscussRounds(from, to);

                            if (activeTab === "message") {
                              return (
                                <div
                                  key={to}
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "1fr 70px 70px",
                                    gap: "6px",
                                    padding: "6px 10px",
                                    background: routeAllowed ? "var(--bg-surface)" : "transparent",
                                    borderRadius: "6px",
                                    alignItems: "center"
                                  }}
                                >
                                  <label
                                    style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={routeAllowed}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        toggleRoute(from, to);
                                      }}
                                      style={{ width: "14px", height: "14px" }}
                                    />
                                    <span
                                      style={{
                                        fontSize: "12px",
                                        color: routeAllowed ? "var(--text-primary)" : "var(--text-muted)",
                                        fontWeight: routeAllowed ? 500 : 400
                                      }}
                                    >
                                      {to}
                                    </span>
                                  </label>

                                  <div style={{ textAlign: "center" }}>
                                    <input
                                      type="number"
                                      min={1}
                                      max={10}
                                      value={rounds}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        setDiscussRoundsForRoute(from, to, parseInt(e.target.value) || 3);
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      disabled={!routeAllowed}
                                      style={{
                                        width: "40px",
                                        textAlign: "center",
                                        padding: "2px 4px",
                                        fontSize: "11px",
                                        opacity: routeAllowed ? 1 : 0.5
                                      }}
                                    />
                                  </div>

                                  <div style={{ textAlign: "center" }}>
                                    <input
                                      type="checkbox"
                                      checked={routeAllowed}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        toggleRoute(from, to);
                                      }}
                                      style={{ width: "14px", height: "14px" }}
                                    />
                                  </div>
                                </div>
                              );
                            }

                            return (
                              <div
                                key={to}
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "1fr 70px",
                                  gap: "6px",
                                  padding: "6px 10px",
                                  background: assignAllowed ? "var(--bg-surface)" : "transparent",
                                  borderRadius: "6px",
                                  alignItems: "center"
                                }}
                              >
                                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                  <input
                                    type="checkbox"
                                    checked={assignAllowed}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      toggleTaskAssign(from, to);
                                    }}
                                    style={{ width: "14px", height: "14px" }}
                                  />
                                  <span
                                    style={{
                                      fontSize: "12px",
                                      color: assignAllowed ? "var(--text-primary)" : "var(--text-muted)",
                                      fontWeight: assignAllowed ? 500 : 400
                                    }}
                                  >
                                    {to}
                                  </span>
                                </label>

                                <div style={{ textAlign: "center" }}>
                                  <input
                                    type="checkbox"
                                    checked={assignAllowed}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      toggleTaskAssign(from, to);
                                    }}
                                    style={{ width: "14px", height: "14px" }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <div style={{ flexShrink: 0, paddingTop: "16px", display: "flex", gap: "8px" }}>
        <button className="btn btn-primary btn-lg" disabled={saving} onClick={onSave}>
          {saving ? <Loader size={18} className="loading-spinner" /> : <Save size={18} />}
          {saving ? t.saving : t.save}
        </button>
        <a href="#/teams" className="btn btn-secondary btn-lg">
          {t.cancel}
        </a>
      </div>
    </section>
  );
}
