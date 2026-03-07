import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowTemplateRecord,
  WorkflowRunRecord,
  WorkflowRunRuntimeStatus,
  WorkflowOrchestratorStatus
} from "@/types";
import { workflowApi } from "@/services/api";

export function useWorkflowTemplates() {
  const [items, setItems] = useState<WorkflowTemplateRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await workflowApi.listTemplates();
      setItems(payload.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, error, reload };
}

export function useWorkflowRuns() {
  const [items, setItems] = useState<WorkflowRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await workflowApi.listRuns();
      setItems(payload.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (closed) {
        return;
      }
      try {
        const payload = await workflowApi.listRuns();
        if (!closed) {
          const nextItems = payload.items ?? [];
          setItems(nextItems);
          setError(null);
          setLoading(false);
          const hasRunning = nextItems.some((item) => item.status === "running");
          timer = setTimeout(poll, hasRunning ? 5000 : 12000);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load workflow runs");
          setLoading(false);
          timer = setTimeout(poll, 12000);
        }
      }
    };

    poll();
    return () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return { items, loading, error, reload };
}

export function useWorkflowRunStatus(runId: string | undefined) {
  const [status, setStatus] = useState<WorkflowRunRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!runId) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const payload = await workflowApi.getRunStatus(runId);
      setStatus(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow run status");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      return;
    }
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const payload = await workflowApi.getRunStatus(runId);
        if (!closed) {
          setStatus(payload);
          setError(null);
          setLoading(false);
          const interval = payload.status === "running" ? 3000 : 10000;
          timer = setTimeout(poll, interval);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load workflow run status");
          setLoading(false);
          timer = setTimeout(poll, 10000);
        }
      }
    };
    poll();
    return () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [runId]);

  return { status, loading, error, reload };
}

export function useWorkflowOrchestratorStatus(intervalMs = 8000) {
  const [status, setStatus] = useState<WorkflowOrchestratorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await workflowApi.getOrchestratorStatus();
      setStatus(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow orchestrator status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const payload = await workflowApi.getOrchestratorStatus();
        if (!closed) {
          setStatus(payload);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load workflow orchestrator status");
          setLoading(false);
        }
      } finally {
        if (!closed) {
          timer = setTimeout(poll, intervalMs);
        }
      }
    };
    poll();
    return () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [intervalMs]);

  const activeRunLabel = useMemo(() => {
    if (!status || status.activeRunIds.length === 0) {
      return "-";
    }
    return status.activeRunIds.join(", ");
  }, [status]);

  return { status, loading, error, reload, activeRunLabel };
}
