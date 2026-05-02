import type express from "express";
import type { AppRuntimeContext } from "../shared/context.js";
import {
  parseBoolean,
  parseInteger,
  parseReminderMode,
  parseScheduleExpression,
  parseWorkflowRunMode,
  readStringField
} from "../shared/http.js";
import { hasOwnField, validateRecurringConfig, withWorkflowRoutePerfTrace } from "./route-utils.js";

export function registerWorkflowOrchestratorRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, workflowOrchestrator } = context;

  app.get("/api/workflow-orchestrator/status", async (_req, res, next) => {
    try {
      res.json(await workflowOrchestrator.getStatus());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-runs/:run_id/orchestrator/settings", async (req, res, next) => {
    try {
      const settings = await workflowOrchestrator.getRunOrchestratorSettings(req.params.run_id);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/workflow-runs/:run_id/orchestrator/settings", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const reminderModeRaw = body.reminder_mode ?? body.reminderMode;
      const parsedReminderMode = parseReminderMode(reminderModeRaw);
      if (reminderModeRaw !== undefined && !parsedReminderMode) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "reminder_mode must be backoff|fixed_interval"
        });
        return;
      }
      const modeRaw = body.mode ?? body.run_mode ?? body.runMode;
      const parsedMode = parseWorkflowRunMode(modeRaw);
      if (modeRaw !== undefined && !parsedMode) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "mode must be none|loop|schedule"
        });
        return;
      }
      const hasLoopEnabled = hasOwnField(body, "loop_enabled", "loopEnabled");
      const hasScheduleEnabled = hasOwnField(body, "schedule_enabled", "scheduleEnabled");
      const hasScheduleExpression = hasOwnField(body, "schedule_expression", "scheduleExpression");
      const hasIsScheduleSeed = hasOwnField(body, "is_schedule_seed", "isScheduleSeed");
      const incomingLoopEnabled = hasLoopEnabled
        ? parseBoolean(body.loop_enabled ?? body.loopEnabled, false)
        : undefined;
      const incomingScheduleEnabled = hasScheduleEnabled
        ? parseBoolean(body.schedule_enabled ?? body.scheduleEnabled, false)
        : undefined;
      let incomingScheduleExpression: string | null | undefined;
      if (hasScheduleExpression) {
        const rawScheduleExpression = body.schedule_expression ?? body.scheduleExpression;
        if (rawScheduleExpression === null) {
          incomingScheduleExpression = null;
        } else {
          const parsedExpression = parseScheduleExpression(rawScheduleExpression);
          if (!parsedExpression) {
            res.status(400).json({
              code: "ORCHESTRATOR_SETTINGS_INVALID",
              error: "schedule_expression must be a non-empty MM-DD HH:MM string"
            });
            return;
          }
          incomingScheduleExpression = parsedExpression;
        }
      }
      const incomingIsScheduleSeed = hasIsScheduleSeed
        ? parseBoolean(body.is_schedule_seed ?? body.isScheduleSeed, false)
        : undefined;
      let recurringConfigError: string | null = null;
      const settings = await withWorkflowRoutePerfTrace(
        dataRoot,
        req.params.run_id,
        "PATCH /api/workflow-runs/:run_id/orchestrator/settings",
        async () => {
          const currentSettings = await workflowOrchestrator.getRunOrchestratorSettings(req.params.run_id);
          const mergedLoopEnabled =
            incomingLoopEnabled ??
            (parsedMode === "loop" ? true : parsedMode === "schedule" ? false : currentSettings.loop_enabled);
          const mergedScheduleEnabled =
            incomingScheduleEnabled ??
            (parsedMode === "schedule" ? true : parsedMode === "loop" ? false : currentSettings.schedule_enabled);
          const mergedMode = parsedMode ?? (mergedScheduleEnabled ? "schedule" : mergedLoopEnabled ? "loop" : "none");
          const mergedScheduleExpressionRaw =
            incomingScheduleExpression === undefined
              ? currentSettings.schedule_expression
              : (incomingScheduleExpression ?? undefined);
          const mergedScheduleExpression =
            mergedMode === "schedule" || mergedScheduleEnabled ? mergedScheduleExpressionRaw : undefined;
          const scheduleTransitionedToEnabled =
            (mergedMode === "schedule" || mergedScheduleEnabled) &&
            !(currentSettings.mode === "schedule" || currentSettings.schedule_enabled);
          const mergedIsScheduleSeed =
            incomingIsScheduleSeed ?? (scheduleTransitionedToEnabled ? true : currentSettings.is_schedule_seed);
          const recurringError = validateRecurringConfig({
            mode: mergedMode,
            loopEnabled: mergedLoopEnabled,
            scheduleEnabled: mergedScheduleEnabled,
            scheduleExpression: mergedScheduleExpression
          });
          if (recurringError) {
            recurringConfigError = recurringError;
            return null;
          }
          const shouldClearScheduleExpression =
            incomingScheduleExpression === undefined && mergedMode !== "schedule" && !mergedScheduleEnabled;
          const loopEnabledPatch = incomingLoopEnabled ?? (parsedMode ? mergedLoopEnabled : undefined);
          const scheduleEnabledPatch = incomingScheduleEnabled ?? (parsedMode ? mergedScheduleEnabled : undefined);
          return await workflowOrchestrator.patchRunOrchestratorSettings(req.params.run_id, {
            autoDispatchEnabled:
              body.auto_dispatch_enabled === undefined && body.autoDispatchEnabled === undefined
                ? undefined
                : parseBoolean(body.auto_dispatch_enabled ?? body.autoDispatchEnabled, false),
            autoDispatchRemaining: parseInteger(body.auto_dispatch_remaining ?? body.autoDispatchRemaining),
            holdEnabled:
              body.hold_enabled === undefined && body.holdEnabled === undefined
                ? undefined
                : parseBoolean(body.hold_enabled ?? body.holdEnabled, false),
            reminderMode: parsedReminderMode,
            mode: parsedMode ?? (hasLoopEnabled || hasScheduleEnabled ? mergedMode : undefined),
            loopEnabled: loopEnabledPatch,
            scheduleEnabled: scheduleEnabledPatch,
            scheduleExpression: shouldClearScheduleExpression ? null : incomingScheduleExpression,
            isScheduleSeed: mergedIsScheduleSeed
          });
        }
      );
      if (recurringConfigError) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: recurringConfigError
        });
        return;
      }
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/orchestrator/dispatch", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const result = await withWorkflowRoutePerfTrace(
        dataRoot,
        req.params.run_id,
        "POST /api/workflow-runs/:run_id/orchestrator/dispatch",
        async () =>
          await workflowOrchestrator.dispatchRun(req.params.run_id, {
            source: "manual",
            role: readStringField(body, ["role"]),
            taskId: readStringField(body, ["task_id", "taskId"]),
            force: parseBoolean(body.force, false),
            onlyIdle: parseBoolean(body.only_idle ?? body.onlyIdle, false)
          })
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });
}
