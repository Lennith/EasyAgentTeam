import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectSummary, ProjectDetail, SessionRecord, TaskTreeNode, LockRecord, EventRecord, AgentIOTimelineItem, OrchestratorStatus } from "@/types";
import { projectApi, orchestratorApi } from "@/services/api";
import { useSettings } from "./useSettings";
import * as mockData from "@/mock/data";

export function useProjects() {
  const { settings } = useSettings();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    async function load() {
      setLoading(true);
      
      if (settings.useMockData) {
        if (!closed) {
          setProjects(mockData.mockProjects);
          setError(null);
          setLoading(false);
        }
        return;
      }
      
      try {
        const payload = await projectApi.list();
        if (!closed) {
          setProjects(payload.items ?? []);
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load projects");
        }
      } finally {
        if (!closed) setLoading(false);
      }
    }
    load();
    return () => { closed = true; };
  }, [settings.useMockData]);

  const reload = useCallback(() => {
    setProjects([]);
    setLoading(true);
    
    if (settings.useMockData) {
      setProjects(mockData.mockProjects);
      setLoading(false);
      return;
    }
    
    projectApi.list()
      .then((payload) => {
        setProjects(payload.items ?? []);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => setLoading(false));
  }, [settings.useMockData]);

  return { projects, loading, error, reload };
}

export function useProjectWorkspace(projectId: string | undefined) {
  const { settings } = useSettings();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [taskNodes, setTaskNodes] = useState<TaskTreeNode[]>([]);
  const [locks, setLocks] = useState<LockRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [timeline, setTimeline] = useState<AgentIOTimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const sinceRef = useRef<string | undefined>();

  useEffect(() => {
    if (!projectId) return;
    
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    
    async function poll() {
      if (!projectId) return;
      
      if (settings.useMockData) {
        if (!closed) {
          setProject(mockData.mockProjectDetail);
          setSessions(mockData.mockSessions);
          setTaskNodes(mockData.mockTasks);
          setLocks(mockData.mockLocks);
          setEvents(mockData.mockEvents);
          setTimeline(mockData.mockTimeline);
          setError(null);
          setLoading(false);
        }
        timer = setTimeout(poll, 5000);
        return;
      }
      
      try {
        const [projectRes, sessionRes, taskTreeRes, lockRes] = await Promise.all([
          projectApi.get(projectId),
          projectApi.getSessions(projectId),
          projectApi.getTaskTree(projectId),
          projectApi.getLocks(projectId),
        ]);
        
        let newEvents: EventRecord[] = [];
        try {
          newEvents = await projectApi.getEvents(projectId, sinceRef.current);
          if (newEvents.length > 0) {
            sinceRef.current = newEvents[newEvents.length - 1].createdAt;
          }
        } catch {
        }
        
        let timelineRes: { items: AgentIOTimelineItem[] } | null = null;
        try {
          timelineRes = await projectApi.getAgentIOTimeline(projectId, 0);
        } catch {
        }
        
        if (!closed) {
          setProject(projectRes);
          setSessions(sessionRes.items ?? []);
          setTaskNodes(taskTreeRes.nodes ?? []);
          setLocks(lockRes.items ?? []);
          if (newEvents.length > 0) {
            setEvents(prev => [...prev, ...newEvents]);
          }
          if (timelineRes) {
            setTimeline(timelineRes.items ?? []);
          }
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load project");
          setLoading(false);
        }
      } finally {
        if (!closed) {
          timer = setTimeout(poll, 2000);
        }
      }
    }
    
    setProject(null);
    setSessions([]);
    setTaskNodes([]);
    setLocks([]);
    setEvents([]);
    setTimeline([]);
    sinceRef.current = undefined;
    setLoading(true);
    poll();
    
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, reloadTick, settings.useMockData]);

  return {
    project,
    sessions,
    tasks: taskNodes,
    taskNodes,
    locks,
    events,
    timeline,
    loading,
    error,
    reload: useCallback(() => setReloadTick(v => v + 1), []),
  };
}

export function useOrchestratorStatus() {
  const { settings } = useSettings();
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (settings.useMockData) {
        if (!closed) {
          setStatus(mockData.mockOrchestratorStatus);
          setError(null);
        }
        timer = setTimeout(poll, 5000);
        return;
      }
      
      try {
        const data = await orchestratorApi.getStatus();
        if (!closed) {
          setStatus(data);
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to get orchestrator status");
        }
      } finally {
        if (!closed) {
          timer = setTimeout(poll, 2500);
        }
      }
    }

    poll();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
  }, [settings.useMockData]);

  return { status, error };
}

export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = useCallback((value: T) => {
    setStoredValue(value);
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
    }
  }, [key]);

  return [storedValue, setValue];
}
