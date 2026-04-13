import { useState, useEffect, useCallback } from "react";
import type {
  L1Route,
  ProjectView,
  AgentView,
  DebugView,
  TeamView,
  WorkflowRunWorkspaceView,
  SkillView
} from "@/types";

export function useRoute() {
  const [route, setRoute] = useState<L1Route>({ l1: "home" });

  const parseHash = useCallback((hash: string): L1Route => {
    const cleanHash = hash.replace(/^#/, "").split("?")[0] ?? "";
    const parts = cleanHash.split("/").filter(Boolean);

    if (parts.length === 0 || parts[0] === "") {
      return { l1: "home" };
    }

    const l1 = parts[0];

    if (l1 === "new-project") {
      return { l1: "new-project" };
    }

    if (l1 === "projects") {
      return { l1: "projects" };
    }

    if (l1 === "project" && parts[1]) {
      const projectId = parts[1];
      const view = (parts[2] as ProjectView) || "timeline";
      return { l1: "project", projectId, view };
    }

    if (l1 === "teams") {
      const view = (parts[1] as TeamView) || "list";
      const teamId = parts[2];
      return { l1: "teams", view, teamId };
    }

    if (l1 === "workflow") {
      const area = parts[1];
      if (!area) {
        return { l1: "workflow", view: "runs" };
      }
      if (area === "runs") {
        if (parts[2] === "new") {
          return { l1: "workflow", view: "new-run" };
        }
        if (parts[2]) {
          const runId = parts[2];
          const runViewRaw = parts[3];
          const runView: WorkflowRunWorkspaceView =
            runViewRaw === "task-tree" ||
            runViewRaw === "team-config" ||
            runViewRaw === "overview" ||
            runViewRaw === "chat" ||
            runViewRaw === "agent-chat"
              ? runViewRaw
              : "overview";
          return { l1: "workflow", view: "run-workspace", runId, runView };
        }
        return { l1: "workflow", view: "runs" };
      }
      if (area === "templates") {
        if (parts[2] === "new") {
          return { l1: "workflow", view: "new-template" };
        }
        if (parts[2] && parts[3] === "edit") {
          return { l1: "workflow", view: "edit-template", templateId: parts[2] };
        }
        return { l1: "workflow", view: "templates" };
      }
      return { l1: "workflow", view: "runs" };
    }

    if (l1 === "skills") {
      const viewRaw = (parts[1] as SkillView) || "library";
      const view: SkillView = viewRaw === "lists" ? "lists" : "library";
      return { l1: "skills", view };
    }

    // backward compatibility for old template L1 paths
    if (l1 === "templates") {
      const segment = parts[1];
      if (!segment) {
        return { l1: "workflow", view: "templates" };
      }
      if (segment === "new") {
        return { l1: "workflow", view: "new-template" };
      }
      if (parts[2] === "edit") {
        return { l1: "workflow", view: "edit-template", templateId: segment };
      }
      return { l1: "workflow", view: "templates" };
    }

    if (l1 === "agents") {
      const view = (parts[1] as AgentView) || "sessions";
      return { l1: "agents", view };
    }

    if (l1 === "debug") {
      const debugViewRaw = parts[1];
      const debugView: DebugView =
        debugViewRaw === "agent-output" || debugViewRaw === "session-prompts" ? debugViewRaw : "agent-sessions";
      return { l1: "debug", debugView };
    }

    if (l1 === "settings") {
      return { l1: "settings" };
    }

    return { l1: "home" };
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseHash(window.location.hash));
    };

    handleHashChange();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [parseHash]);

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  return { route, navigate };
}
