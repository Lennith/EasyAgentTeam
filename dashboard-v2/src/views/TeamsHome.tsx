import { useState, useEffect } from "react";
import { useTranslation } from "@/hooks/i18n";
import { teamApi } from "@/services/api";
import type { TeamSummary } from "@/types";
import { UserCircle, ArrowRight, Trash2 } from "lucide-react";

export function TeamsHome() {
  const t = useTranslation();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await teamApi.list();
      setTeams(result.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load teams");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTeams();
  }, []);

  const handleDelete = async (teamId: string) => {
    try {
      await teamApi.delete(teamId);
      setTeams(teams.filter((team) => team.teamId !== teamId));
    } catch (err) {
      console.error("Failed to delete team:", err);
    }
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.teams}</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>{t.loadingTeams}</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.teams}</h1>
        </div>
        <div className="error-message">{error}</div>
        <button className="btn btn-secondary" onClick={loadTeams}>
          {t.retry}
        </button>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>{t.teams}</h1>
        <a href="#/teams/new" className="btn btn-primary">
          + {t.newTeam}
        </a>
      </div>

      {teams.length === 0 ? (
        <div className="empty-state">
          <UserCircle size={48} style={{ opacity: 0.3 }} />
          <p>{t.noTeams}</p>
          <a href="#/teams/new" className="btn btn-primary">
            {t.newTeam}
          </a>
        </div>
      ) : (
        <div className="grid grid-2">
          {teams.map((team) => (
            <div key={team.teamId} className="card">
              <div className="card-header">
                <h3>{team.name}</h3>
                <span className="badge badge-neutral">{team.teamId}</span>
              </div>
              {team.description && (
                <div style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "8px" }}>
                  {team.description}
                </div>
              )}
              <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px" }}>
                {t.memberCount}: {team.agentCount}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <a href={`#/teams/edit/${team.teamId}`} className="btn btn-primary">
                  {t.teamMembers}
                  <ArrowRight size={14} />
                </a>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (window.confirm(`${t.confirmDeleteTeam}: ${team.name}?`)) {
                      handleDelete(team.teamId);
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
