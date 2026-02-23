import { useTranslation } from "@/hooks/i18n";
import type { ProjectSummary } from "@/types";
import { FolderKanban, ArrowRight, Trash2 } from "lucide-react";

interface ProjectsHomeProps {
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
  onDelete: (projectId: string) => void;
}

export function ProjectsHome({ projects, loading, error, onDelete }: ProjectsHomeProps) {
  const t = useTranslation();

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.projects}</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>{t.loading}</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.projects}</h1>
        </div>
        <div className="error-message">{error}</div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>{t.projects}</h1>
        <a href="#/new-project" className="btn btn-primary">
          + {t.createProject}
        </a>
      </div>

      {projects.length === 0 ? (
        <div className="empty-state">
          <FolderKanban size={48} style={{ opacity: 0.3 }} />
          <p>{t.noProjects}</p>
          <a href="#/new-project" className="btn btn-primary">
            {t.createProject}
          </a>
        </div>
      ) : (
        <div className="grid grid-2">
          {projects.map((project) => (
            <div key={project.projectId} className="card">
              <div className="card-header">
                <h3>{project.name}</h3>
                <span className="badge badge-neutral">{project.projectId}</span>
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px" }}>
                {project.workspacePath}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <a href={`#/project/${project.projectId}/timeline`} className="btn btn-primary">
                  {t.projectOverview}
                  <ArrowRight size={14} />
                </a>
                <button 
                  className="btn btn-danger"
                  onClick={() => {
                    if (window.confirm(`${t.confirmDeleteProject}: ${project.name}?`)) {
                      onDelete(project.projectId);
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
