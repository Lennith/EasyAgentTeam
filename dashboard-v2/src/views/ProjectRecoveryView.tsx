import { useCallback, useEffect, useState } from "react";
import { projectApi } from "@/services/api";
import type { RuntimeRecoveryResponse } from "@/types";
import { RecoveryCenterView } from "./RecoveryCenterView";

interface ProjectRecoveryViewProps {
  projectId: string;
}

export function ProjectRecoveryView({ projectId }: ProjectRecoveryViewProps) {
  const [response, setResponse] = useState<RuntimeRecoveryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await projectApi.getRuntimeRecovery(projectId);
      setResponse(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recovery incidents");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <RecoveryCenterView
      title="Project Recovery"
      loading={loading}
      error={error}
      response={response}
      onReload={() => void load()}
      onDismiss={(sessionId, confirm) =>
        projectApi.dismissSession(projectId, sessionId, undefined, confirm).then(() => undefined)
      }
      onRepair={(sessionId, target, confirm) =>
        projectApi.repairSession(projectId, sessionId, target, confirm).then(() => undefined)
      }
      onRetry={(item, confirm) => projectApi.retryDispatchSession(projectId, item, confirm).then(() => undefined)}
      onLoadRecoveryAttempts={(sessionId) => projectApi.getSessionRecoveryAttempts(projectId, sessionId, "all")}
    />
  );
}
