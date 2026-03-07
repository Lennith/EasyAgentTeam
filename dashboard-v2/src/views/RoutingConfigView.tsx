import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/hooks/i18n";
import type {
  ProjectDetail,
  SessionRecord,
  TaskTreeNode,
  LockRecord,
  EventRecord,
  AgentIOTimelineItem,
  AgentModelConfig,
  ModelInfo
} from "@/types";
import { projectApi, modelsApi } from "@/services/api";
import { Save, Loader, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";

interface RoutingConfigViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

interface DiscussRoundsConfig {
  [from: string]: {
    [to: string]: number;
  };
}

export function RoutingConfigView({ projectId, project, reload }: RoutingConfigViewProps) {
  const t = useTranslation();
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [routeTable, setRouteTable] = useState<Record<string, string[]>>({});
  const [taskAssignRouteTable, setTaskAssignRouteTable] = useState<Record<string, string[]>>({});
  const [discussRounds, setDiscussRounds] = useState<DiscussRoundsConfig>({});
  const [modelConfigs, setModelConfigs] = useState<Record<string, AgentModelConfig>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newAgentId, setNewAgentId] = useState("");
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    if (project && !initializedRef.current) {
      initializedRef.current = true;
      setAgentIds(project.agentIds ?? []);
      setRouteTable(project.routeTable ?? {});
      setTaskAssignRouteTable(project.taskAssignRouteTable ?? {});
      setDiscussRounds(
        ((project as unknown as Record<string, unknown>).routeDiscussRounds as DiscussRoundsConfig) ?? {}
      );
      setModelConfigs(project.agentModelConfigs ?? {});
    }
  }, [project]);

  useEffect(() => {
    loadModels(false);
  }, [projectId]);

  async function loadModels(refresh: boolean) {
    try {
      const res = await modelsApi.list(projectId, refresh);
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
  }

  function getTargetAgents(from: string): string[] {
    return routeTable[from] ?? [];
  }

  function getModelsForTool(tool: "codex" | "trae" | "minimax"): ModelInfo[] {
    return availableModels.filter((m) => m.vendor === tool);
  }

  async function onSave() {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      await projectApi.updateRoutingConfig(projectId, {
        agent_ids: agentIds,
        route_table: routeTable,
        route_discuss_rounds: discussRounds,
        agent_model_configs: modelConfigs
      });

      const filteredTaskAssignRouteTable: Record<string, string[]> = {};
      for (const [from, targets] of Object.entries(taskAssignRouteTable)) {
        const allowedTargets = routeTable[from] ?? [];
        const validTargets = targets.filter((to) => allowedTargets.includes(to));
        if (validTargets.length > 0) {
          filteredTaskAssignRouteTable[from] = validTargets;
        }
      }

      await projectApi.updateTaskAssignRouting(projectId, filteredTaskAssignRouteTable);

      setSuccess(t.settingsSaved);
      initializedRef.current = false;
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.teamConfig}</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-secondary btn-sm" onClick={expandAll}>
            Expand All
          </button>
          <button className="btn btn-secondary btn-sm" onClick={collapseAll}>
            Collapse All
          </button>
        </div>
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

        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {agentIds.map((agent) => (
            <div
              key={agent}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                padding: "6px 12px",
                background: "var(--bg-elevated)",
                borderRadius: "6px"
              }}
            >
              <span>{agent}</span>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => removeAgent(agent)}
                style={{ padding: "2px 4px" }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div
        className="card"
        style={{
          flex: "1",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          marginTop: "16px",
          overflow: "hidden"
        }}
      >
        <div className="card-header" style={{ flexShrink: 0 }}>
          <h3>{t.routingMatrix}</h3>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Configure which agents can send messages/assign tasks to others
          </span>
        </div>

        <div
          className="routing-matrix-scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
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
                      flexWrap: "wrap"
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        cursor: "pointer",
                        flex: "1 1 auto",
                        minWidth: "150px"
                      }}
                      onClick={() => toggleExpand(from)}
                    >
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span style={{ fontWeight: 600 }}>{from}</span>
                      <span className="badge badge-neutral" style={{ fontSize: "11px" }}>
                        {targets.length} targets
                      </span>
                    </div>

                    <div
                      style={{ display: "flex", gap: "6px", alignItems: "center", flex: "0 0 auto" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <select
                        value={modelConfigs[from]?.tool ?? "codex"}
                        onChange={(e) =>
                          setModelConfigs((prev) => ({
                            ...prev,
                            [from]: { ...prev[from], tool: e.target.value as "codex" | "trae" | "minimax" }
                          }))
                        }
                        style={{ fontSize: "11px", padding: "2px 6px", width: "70px" }}
                      >
                        <option value="codex">Codex</option>
                        <option value="trae">Trae</option>
                        <option value="minimax">MiniMax</option>
                      </select>
                      <select
                        value={modelConfigs[from]?.model ?? ""}
                        onChange={(e) =>
                          setModelConfigs((prev) => ({
                            ...prev,
                            [from]: { ...prev[from], model: e.target.value }
                          }))
                        }
                        style={{ fontSize: "11px", padding: "2px 6px", width: "100px" }}
                      >
                        <option value="">Model...</option>
                        {getModelsForTool(modelConfigs[from]?.tool ?? "codex").map((m) => (
                          <option key={m.model} value={m.model}>
                            {m.model.length > 12 ? m.model.slice(0, 12) + "..." : m.model}
                          </option>
                        ))}
                      </select>
                      <select
                        value={modelConfigs[from]?.effort ?? "medium"}
                        onChange={(e) =>
                          setModelConfigs((prev) => ({
                            ...prev,
                            [from]: { ...prev[from], effort: e.target.value as "low" | "medium" | "high" }
                          }))
                        }
                        style={{ fontSize: "11px", padding: "2px 6px", width: "60px" }}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Med</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{ padding: "0 16px 16px", marginLeft: "28px" }}>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(120px, 1fr) 70px 70px 70px",
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
                        <span style={{ textAlign: "center" }}>Assign</span>
                      </div>

                      {agentIds
                        .filter((to) => to !== from)
                        .map((to) => {
                          const routeAllowed = isRouteAllowed(from, to);
                          const assignAllowed = isTaskAssignAllowed(from, to);
                          const rounds = getDiscussRounds(from, to);

                          return (
                            <div
                              key={to}
                              style={{
                                display: "grid",
                                gridTemplateColumns: "minmax(120px, 1fr) 70px 70px 70px",
                                gap: "6px",
                                padding: "6px 10px",
                                background: routeAllowed ? "var(--bg-surface)" : "transparent",
                                borderRadius: "6px",
                                alignItems: "center"
                              }}
                            >
                              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
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
                                  title={routeAllowed ? "Route enabled" : "Click to enable route"}
                                />
                              </div>

                              <div style={{ textAlign: "center" }}>
                                <input
                                  type="checkbox"
                                  checked={assignAllowed}
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    toggleTaskAssign(from, to);
                                  }}
                                  disabled={!routeAllowed}
                                  style={{ width: "14px", height: "14px", opacity: routeAllowed ? 1 : 0.3 }}
                                  title={
                                    routeAllowed
                                      ? assignAllowed
                                        ? "Can assign tasks"
                                        : "Click to enable task assignment"
                                      : "Enable route first"
                                  }
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

      <div style={{ flexShrink: 0, paddingTop: "16px" }}>
        <button className="btn btn-primary btn-lg" disabled={saving} onClick={onSave}>
          {saving ? <Loader size={18} className="loading-spinner" /> : <Save size={18} />}
          {saving ? t.saving : t.save}
        </button>
      </div>
    </section>
  );
}
