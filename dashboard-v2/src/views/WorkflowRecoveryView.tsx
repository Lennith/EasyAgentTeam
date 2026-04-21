import { useCallback, useEffect, useState } from "react";
import { workflowApi } from "@/services/api";
import type { RuntimeRecoveryResponse } from "@/types";
import { RecoveryCenterView } from "./RecoveryCenterView";

interface WorkflowRecoveryViewProps {
  runId: string;
}

export function WorkflowRecoveryView({ runId }: WorkflowRecoveryViewProps) {
  const [response, setResponse] = useState<RuntimeRecoveryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await workflowApi.getRuntimeRecovery(runId);
      setResponse(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow recovery incidents");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <RecoveryCenterView
      title="Workflow Recovery"
      loading={loading}
      error={error}
      response={response}
      onReload={() => void load()}
      onDismiss={(sessionId, confirm) =>
        workflowApi.dismissSession(runId, sessionId, undefined, confirm).then(() => undefined)
      }
      onRepair={(sessionId, target, confirm) =>
        workflowApi.repairSession(runId, sessionId, target, confirm).then(() => undefined)
      }
      onRetry={(item, confirm) => workflowApi.retryDispatchSession(runId, item, confirm).then(() => undefined)}
    />
  );
}
