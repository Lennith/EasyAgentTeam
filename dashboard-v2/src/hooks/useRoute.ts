import { useState, useEffect, useCallback } from "react";
import type { L1Route, ProjectView, AgentView, DebugView, TeamView } from "@/types";

export function useRoute() {
  const [route, setRoute] = useState<L1Route>({ l1: "home" });

  const parseHash = useCallback((hash: string): L1Route => {
    const parts = hash.replace(/^#/, "").split("/").filter(Boolean);
    
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
    
    if (l1 === "agents") {
      const view = (parts[1] as AgentView) || "sessions";
      return { l1: "agents", view };
    }
    
    if (l1 === "debug") {
      const debugView = (parts[1] as DebugView) || "agent-sessions";
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
