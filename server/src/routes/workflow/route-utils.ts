import { parseWorkflowScheduleExpression } from "../../services/orchestrator/workflow/workflow-recurring-schedule.js";
import { recordWorkflowPerfSpan, traceWorkflowPerfSpan } from "../../services/workflow-perf-trace.js";

export function hasOwnField(body: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

export function validateRecurringConfig(input: {
  mode: "none" | "loop" | "schedule";
  loopEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleExpression?: string;
}): string | null {
  if (input.loopEnabled && input.scheduleEnabled) {
    return "loop and schedule cannot be enabled together";
  }
  if (input.mode === "loop" && input.scheduleEnabled) {
    return "mode=loop cannot enable schedule";
  }
  if (input.mode === "schedule" && input.loopEnabled) {
    return "mode=schedule cannot enable loop";
  }
  if (input.mode === "schedule" || input.scheduleEnabled) {
    if (!input.scheduleExpression) {
      return "schedule_expression is required when schedule is enabled";
    }
    if (!parseWorkflowScheduleExpression(input.scheduleExpression)) {
      return "schedule_expression must be in MM-DD HH:MM format with XX support";
    }
  } else if (input.scheduleExpression) {
    return "schedule_expression is only allowed when schedule is enabled";
  }
  return null;
}

export async function withWorkflowRoutePerfTrace<T>(
  dataRoot: string,
  runId: string,
  routeName: string,
  operation: () => Promise<T>
): Promise<T> {
  return await traceWorkflowPerfSpan(
    {
      dataRoot,
      runId,
      scope: "route",
      name: routeName
    },
    operation
  );
}

export { recordWorkflowPerfSpan };
