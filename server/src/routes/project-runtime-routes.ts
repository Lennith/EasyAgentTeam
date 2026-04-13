import type express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildAgentIOTimeline } from "../services/agent-io-timeline-service.js";
import { streamAgentChat, resolveAgentPromptBundle, resolveRuntimeSettings } from "../services/agent-chat-service.js";
import { handleManagerMessageSend, ManagerMessageServiceError } from "../services/manager-message-service.js";
import {
  buildOrchestratorAgentWorkspaceDir,
  buildOrchestratorMinimaxSessionDir,
  resolveOrchestratorManagerUrl,
  resolveOrchestratorProviderSessionId
} from "../services/orchestrator/shared/index.js";
import {
  acquireProjectLock,
  listProjectLocksForApi,
  releaseProjectLockForApi,
  renewProjectLockForApi
} from "../services/project-lock-service.js";
import {
  appendProjectRuntimeEvent,
  clearProjectRoleSessionMapping,
  createProjectSession,
  getProjectRuntimeContext,
  getProjectSessionById,
  listProjectActiveLocks,
  listProjectInboxItems,
  listProjectRuntimeEventsAsNdjson,
  listProjectSessionsById,
  setProjectRoleSessionMapping,
  touchProjectSession
} from "../services/project-runtime-api-service.js";
import { resolveSessionProviderId } from "../services/provider-runtime.js";
import { createProjectToolExecutionAdapter, DefaultToolInjector } from "../services/tool-injector.js";
import { validateRoleSessionMapWrite } from "../services/routing-guard-service.js";
import { resolveActiveSessionForRole } from "../services/session-lifecycle-authority.js";
import { logger } from "../utils/logger.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { buildSessionId, readStringField, sanitizeSessionForApi, sendApiError } from "./shared/http.js";

export function registerProjectRuntimeRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, orchestrator, providerRegistry } = context;

  app.post("/api/projects/:id/sessions", async (req, res, next) => {
    try {
      const { project, paths } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const body = req.body as Record<string, unknown>;
      const role = (body.role ?? body.to_role) as string | undefined;
      const status = body.status as string | undefined;
      const requestedSessionId = readStringField(body, ["session_id", "sessionId"]);
      const currentTaskId = (body.current_task_id ?? body.currentTaskId) as string | undefined;
      if (!role) {
        res.status(400).json({ error: "role is required" });
        return;
      }
      const configuredProviderId = project.agentModelConfigs?.[role]?.provider_id;
      if (configuredProviderId && configuredProviderId !== "codex" && configuredProviderId !== "minimax") {
        sendApiError(
          res,
          409,
          "SESSION_PROVIDER_NOT_SUPPORTED",
          `role '${role}' is configured with unsupported provider '${configuredProviderId}'`,
          "Only codex and minimax providers are supported for session startup."
        );
        return;
      }
      const candidateSessionId = requestedSessionId ?? buildSessionId(role);
      const existingById = await getProjectSessionById(dataRoot, project.projectId, candidateSessionId);
      if (existingById && existingById.role !== role) {
        sendApiError(
          res,
          409,
          "SESSION_ROLE_MISMATCH",
          `session '${candidateSessionId}' belongs to role '${existingById.role}', not '${role}'`,
          "Use a role-matched session_id or omit session_id for auto generation."
        );
        return;
      }
      const active = await resolveActiveSessionForRole({
        dataRoot,
        project,
        paths,
        role,
        reason: "api_session_create"
      });
      if (active && active.status !== "dismissed" && active.sessionId !== candidateSessionId) {
        sendApiError(
          res,
          409,
          "SESSION_ROLE_CONFLICT",
          `role '${role}' already has active session '${active.sessionId}'`,
          "Dismiss/repair the existing role session before creating a new one."
        );
        return;
      }
      const roleProviderId = project.agentModelConfigs?.[role]?.provider_id ?? "minimax";
      const created = await createProjectSession(dataRoot, project.projectId, {
        sessionId: candidateSessionId,
        role,
        status,
        currentTaskId,
        providerSessionId: undefined,
        provider: roleProviderId
      });
      const mappingError = validateRoleSessionMapWrite(created.session.role, created.session.sessionId);
      if (!mappingError) {
        await setProjectRoleSessionMapping(
          dataRoot,
          project.projectId,
          created.session.role,
          created.session.sessionId
        );
      }
      await orchestrator.resetRoleReminderOnManualAction(project.projectId, created.session.role, "session_created");
      const publicSession = sanitizeSessionForApi(created.session);
      res.status(created.created ? 201 : 200).json({
        session: publicSession,
        created: created.created,
        status: created.session.status
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/sessions", async (req, res, next) => {
    try {
      const { project, paths } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const [sessions, locks] = await Promise.all([
        listProjectSessionsById(dataRoot, project.projectId),
        listProjectActiveLocks(dataRoot, project.projectId)
      ]);
      const roles = Array.from(new Set(sessions.map((session) => session.role)));
      const activeSessions: typeof sessions = [];
      for (const role of roles) {
        const active = await resolveActiveSessionForRole({
          dataRoot,
          project,
          paths,
          role,
          reason: "api_list_sessions"
        });
        if (active) {
          activeSessions.push(active);
        }
      }
      const items = activeSessions
        .map((session) => ({
          ...sanitizeSessionForApi(session),
          locksHeldCount: locks.filter(
            (lock) =>
              lock.ownerSessionId === session.sessionId &&
              lock.ownerDomain === "project" &&
              lock.ownerDomainId === project.projectId
          ).length
        }))
        .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
      res.json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/sessions/:session_id/dismiss", async (req, res, next) => {
    try {
      const { project, paths } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const token = req.params.session_id;
      const session = await getProjectSessionById(dataRoot, project.projectId, token);
      if (!session) {
        res.status(404).json({ error: `session '${token}' not found` });
        return;
      }
      const processTermination = await orchestrator.terminateSessionProcess(
        project.projectId,
        session.sessionId,
        "session_dismissed_by_api"
      );
      const dismissed = await touchProjectSession(dataRoot, project.projectId, session.sessionId, {
        status: "dismissed",
        currentTaskId: null,
        lastInboxMessageId: null,
        agentPid: null
      });
      const mappingCleared = project.roleSessionMap?.[session.role] === session.sessionId;
      if (mappingCleared) {
        await clearProjectRoleSessionMapping(dataRoot, project.projectId, session.role);
      }
      await orchestrator.resetRoleReminderOnManualAction(project.projectId, session.role, "session_dismissed");
      res.status(200).json({ session: sanitizeSessionForApi(dismissed), mappingCleared, processTermination });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/sessions/:session_id/repair", async (req, res, next) => {
    try {
      const targetStatus = readStringField(req.body as Record<string, unknown>, ["target_status", "targetStatus"]);
      if (targetStatus !== "idle" && targetStatus !== "blocked") {
        sendApiError(
          res,
          400,
          "SESSION_REPAIR_INVALID_TARGET",
          "target_status must be idle|blocked",
          "Use target_status=idle or target_status=blocked."
        );
        return;
      }
      const { project } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const token = req.params.session_id;
      const session = await getProjectSessionById(dataRoot, project.projectId, token);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${token}' not found`);
        return;
      }
      const repaired = await orchestrator.repairSessionStatus(req.params.id, session.sessionId, targetStatus);
      await orchestrator.resetRoleReminderOnManualAction(project.projectId, repaired.role, "session_repaired");
      res.status(200).json(sanitizeSessionForApi(repaired));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/inbox/:role", async (req, res, next) => {
    try {
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
      const targetRole = req.params.role;
      const items = await listProjectInboxItems(dataRoot, req.params.id, targetRole, limit);
      res.json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/messages/send", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const messageType = body.message_type || body.messageType || "MANAGER_MESSAGE";
    const fromAgent = body.from_agent || body.fromAgent || "manager";
    logger.info(
      `[API] POST /api/projects/${projectId}/messages/send - message_type=${messageType}, from_agent=${fromAgent} - request received`
    );

    try {
      const { project, paths } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const result = await handleManagerMessageSend(dataRoot, project, paths, body);
      res.status(201).json(result);
      const duration = Date.now() - startTime;
      logger.info(`[API] POST /api/projects/${projectId}/messages/send - completed in ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/messages/send - error after ${duration}ms: ${error}`);
      if (error instanceof ManagerMessageServiceError) {
        if (error.code === "ENDPOINT_RETIRED" && error.replacement) {
          res.status(error.status).json({
            code: error.code,
            error: "endpoint retired",
            replacement: error.replacement
          });
          return;
        }
        sendApiError(
          res,
          error.status,
          error.code,
          error.message,
          error.nextAction,
          error.details ? { details: error.details } : undefined
        );
        return;
      }
      next(error);
    }
  });

  app.post("/api/projects/:id/orchestrator/dispatch", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const { project, paths } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const role = readStringField(body, ["role", "to_role", "toRole"]);
      const requestedSessionId = (body.session_id ?? body.sessionId) as string | undefined;
      let resolvedSessionId = requestedSessionId;
      if (role && requestedSessionId) {
        const requestedSession = await getProjectSessionById(dataRoot, project.projectId, requestedSessionId);
        if (!requestedSession) {
          sendApiError(
            res,
            404,
            "SESSION_NOT_FOUND",
            `session '${requestedSessionId}' not found`,
            "Provide an existing session_id, or omit session_id and dispatch by role."
          );
          return;
        }
        if (requestedSession.role !== role) {
          sendApiError(
            res,
            409,
            "SESSION_ROLE_MISMATCH",
            `session '${requestedSessionId}' does not belong to role '${role}'`,
            "Use a role-matched session_id, or omit session_id and dispatch by role."
          );
          return;
        }
      }
      if (!resolvedSessionId && role) {
        const active = await resolveActiveSessionForRole({
          dataRoot,
          project,
          paths,
          role,
          reason: "api_dispatch_by_role"
        });
        resolvedSessionId = active?.sessionId;
      }
      const result = await orchestrator.dispatchProject(req.params.id, {
        mode: "manual",
        sessionId: resolvedSessionId,
        taskId: (body.task_id ?? body.taskId) as string | undefined,
        force: Boolean(body.force ?? false),
        onlyIdle:
          body.only_idle === undefined && body.onlyIdle === undefined ? false : Boolean(body.only_idle ?? body.onlyIdle)
      });
      const dispatchedCount = result.results.filter(
        (item: (typeof result.results)[number]) => item.outcome === "dispatched"
      ).length;
      if (Boolean(body.force ?? false) && dispatchedCount > 0) {
        const rolesToReset = Array.from(
          new Set(
            result.results
              .filter((item: (typeof result.results)[number]) => item.outcome === "dispatched")
              .map((item: (typeof result.results)[number]) => item.role)
              .filter((item: string) => typeof item === "string" && item.trim().length > 0)
          )
        );
        for (const roleToReset of rolesToReset) {
          await orchestrator.resetRoleReminderOnManualAction(
            project.projectId,
            roleToReset,
            "force_dispatch_succeeded"
          );
        }
      }
      res.status(200).json({ ...result, dispatchedCount });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/orchestrator/dispatch-message", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const messageId = (body.message_id ?? body.messageId) as string | undefined;
      if (!messageId || !messageId.trim()) {
        sendApiError(
          res,
          400,
          "DISPATCH_MESSAGE_ID_REQUIRED",
          "message_id is required",
          "Provide message_id from inbox/timeline item."
        );
        return;
      }
      const result = await orchestrator.dispatchMessage(req.params.id, {
        messageId: messageId.trim(),
        sessionId: (body.session_id ?? body.sessionId) as string | undefined,
        force: Boolean(body.force ?? false),
        onlyIdle:
          body.only_idle === undefined && body.onlyIdle === undefined ? false : Boolean(body.only_idle ?? body.onlyIdle)
      });
      const dispatchedCount = result.results.filter(
        (item: (typeof result.results)[number]) => item.outcome === "dispatched"
      ).length;
      res.status(200).json({ ...result, dispatchedCount });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/events", async (req, res, next) => {
    try {
      const { project } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const body = req.body as Record<string, unknown>;
      const eventType = body.event_type as string | undefined;
      const source = (body.source as "manager" | "agent" | "system" | "dashboard" | undefined) ?? "system";
      const payload = (body.payload as Record<string, unknown> | undefined) ?? {};
      if (!eventType) {
        sendApiError(res, 400, "EVENT_TYPE_REQUIRED", "event_type is required", "Provide event_type string.");
        return;
      }
      const event = await appendProjectRuntimeEvent(dataRoot, project.projectId, {
        projectId: project.projectId,
        eventType,
        source,
        sessionId: readStringField(body, ["session_id", "sessionId"]),
        taskId: readStringField(body, ["task_id", "taskId"]),
        payload
      });
      res.status(201).json(event);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/events", async (req, res, next) => {
    try {
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const ndjson = await listProjectRuntimeEventsAsNdjson(dataRoot, req.params.id, since);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.status(200).send(ndjson);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/agent-io/timeline", async (req, res, next) => {
    try {
      const { project, paths } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
      const timeline = await buildAgentIOTimeline(project, paths, { limit });
      res.status(200).json(timeline);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/locks/acquire", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const sessionId = body.session_id;
    const lockKey = body.lock_key;
    logger.info(
      `[API] POST /api/projects/${projectId}/locks/acquire - session_id=${sessionId}, lock_key=${lockKey} - request received`
    );

    try {
      const sessionId = body.session_id as string | undefined;
      const lockKey = body.lock_key as string | undefined;
      const targetTypeRaw = (body.target_type ?? body.targetType) as string | undefined;
      const targetType = targetTypeRaw === "file" || targetTypeRaw === "dir" ? targetTypeRaw : undefined;
      const ttlSeconds = body.ttl_seconds as number | undefined;
      const purpose = body.purpose as string | undefined;
      if (!sessionId || !lockKey || typeof ttlSeconds !== "number") {
        sendApiError(
          res,
          400,
          "LOCK_ACQUIRE_INPUT_INVALID",
          "session_id, lock_key, ttl_seconds are required",
          "Provide all three fields with ttl_seconds as a number."
        );
        return;
      }
      const acquired = await acquireProjectLock({
        dataRoot,
        projectId,
        sessionId,
        lockKey,
        targetType,
        ttlSeconds,
        purpose
      });
      if (acquired.kind === "acquired") {
        const duration = Date.now() - startTime;
        logger.info(
          `[API] POST /api/projects/${projectId}/locks/acquire - completed in ${duration}ms, result=acquired`
        );
        res.status(201).json({ result: "acquired", lock: acquired.lock });
        return;
      }
      if (acquired.kind === "stolen") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/acquire - completed in ${duration}ms, result=stolen`);
        res.status(201).json({ result: "stolen", lock: acquired.lock, previousLock: acquired.previousLock });
        return;
      }
      const duration = Date.now() - startTime;
      logger.info(`[API] POST /api/projects/${projectId}/locks/acquire - completed in ${duration}ms, result=failed`);
      res.status(409).json({ result: "failed", reason: acquired.reason, existingLock: acquired.existingLock });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/locks/acquire - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.post("/api/projects/:id/locks/renew", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const sessionId = body.session_id;
    const lockKey = body.lock_key;
    logger.info(
      `[API] POST /api/projects/${projectId}/locks/renew - session_id=${sessionId}, lock_key=${lockKey} - request received`
    );

    try {
      const sessionId = body.session_id as string | undefined;
      const lockKey = body.lock_key as string | undefined;
      if (!sessionId || !lockKey) {
        sendApiError(
          res,
          400,
          "LOCK_RENEW_INPUT_INVALID",
          "session_id, lock_key are required",
          "Provide both session_id and lock_key."
        );
        return;
      }
      const renewed = await renewProjectLockForApi({ dataRoot, projectId, sessionId, lockKey });
      if (renewed.kind === "renewed") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/renew - completed in ${duration}ms, result=renewed`);
        res.status(200).json({ result: "renewed", lock: renewed.lock });
        return;
      }
      if (renewed.kind === "not_found") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/renew - completed in ${duration}ms, result=not_found`);
        sendApiError(res, 404, "LOCK_NOT_FOUND", "lock not found", "Acquire lock first.");
        return;
      }
      if (renewed.kind === "not_owner") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/renew - completed in ${duration}ms, result=not_owner`);
        sendApiError(
          res,
          403,
          "LOCK_NOT_OWNER",
          "lock owned by another session",
          "Only lock owner can renew; use the owner session or reacquire after expiry.",
          { existingLock: renewed.existingLock }
        );
        return;
      }
      sendApiError(res, 409, "LOCK_EXPIRED", "lock expired", "Reacquire lock before continuing.", {
        existingLock: renewed.existingLock
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/locks/renew - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.post("/api/projects/:id/locks/release", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const sessionId = body.session_id;
    const lockKey = body.lock_key;
    logger.info(
      `[API] POST /api/projects/${projectId}/locks/release - session_id=${sessionId}, lock_key=${lockKey} - request received`
    );

    try {
      const sessionId = body.session_id as string | undefined;
      const lockKey = body.lock_key as string | undefined;
      if (!sessionId || !lockKey) {
        sendApiError(
          res,
          400,
          "LOCK_RELEASE_INPUT_INVALID",
          "session_id, lock_key are required",
          "Provide both session_id and lock_key."
        );
        return;
      }
      const released = await releaseProjectLockForApi({ dataRoot, projectId, sessionId, lockKey });
      if (released.kind === "released") {
        const duration = Date.now() - startTime;
        logger.info(
          `[API] POST /api/projects/${projectId}/locks/release - completed in ${duration}ms, result=released`
        );
        res.status(200).json({ result: "released", lock: released.lock });
        return;
      }
      if (released.kind === "not_found") {
        const duration = Date.now() - startTime;
        logger.info(
          `[API] POST /api/projects/${projectId}/locks/release - completed in ${duration}ms, result=not_found`
        );
        sendApiError(res, 404, "LOCK_NOT_FOUND", "lock not found", "Lock may already be released.");
        return;
      }
      const duration = Date.now() - startTime;
      logger.info(`[API] POST /api/projects/${projectId}/locks/release - completed in ${duration}ms, result=not_owner`);
      sendApiError(
        res,
        403,
        "LOCK_NOT_OWNER",
        "lock owned by another session",
        "Only lock owner can release this lock.",
        { existingLock: released.existingLock }
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/locks/release - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.get("/api/projects/:id/locks", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    logger.info(`[API] GET /api/projects/${projectId}/locks - request received`);

    try {
      const items = await listProjectLocksForApi(dataRoot, projectId);
      const duration = Date.now() - startTime;
      logger.info(`[API] GET /api/projects/${projectId}/locks - completed in ${duration}ms`);
      res.json({ items, total: items.length });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] GET /api/projects/${projectId}/locks - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.get("/api/projects/:id/agent-output", async (req, res, next) => {
    try {
      const { project } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const auditDir = path.join(dataRoot, "projects", project.projectId, "collab", "audit");
      const filePath = path.join(auditDir, "agent_output.jsonl");
      try {
        const content = await fs.readFile(filePath, "utf-8");
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.status(200).send(content);
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          res.status(404).json({ error: "agent_output.jsonl not found", path: filePath });
          return;
        }
        throw err;
      }
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/agent-chat", async (req, res, next) => {
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const role = (body.role as string)?.trim();
    const prompt = (body.prompt as string)?.trim();
    const sessionId = (body.sessionId as string)?.trim();
    const providerSessionId = (body.providerSessionId as string)?.trim();

    logger.info(
      `[API] POST /api/projects/${projectId}/agent-chat - role=${role}, sessionId=${sessionId}, providerSessionId=${providerSessionId} - request received`
    );

    if (!role) {
      sendApiError(res, 400, "ROLE_REQUIRED", "role is required", "Provide the agent role to chat with.");
      return;
    }
    if (!prompt) {
      sendApiError(res, 400, "PROMPT_REQUIRED", "prompt is required", "Provide the message to send to the agent.");
      return;
    }

    try {
      await streamAgentChat(
        res,
        providerRegistry,
        {
          resolve: async (input) => {
            const { project, paths } = await getProjectRuntimeContext(dataRoot, projectId);
            const settings = await resolveRuntimeSettings(dataRoot);
            const providerId = resolveSessionProviderId(project, input.role, "minimax");
            const promptBundle = await resolveAgentPromptBundle(dataRoot, input.role);
            const chatSessionId = input.sessionId || `agent-chat-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const agentWorkspaceDir = buildOrchestratorAgentWorkspaceDir(project.workspacePath, input.role);
            const toolInjection = DefaultToolInjector.build(
              createProjectToolExecutionAdapter({
                dataRoot,
                project,
                paths,
                agentRole: input.role,
                sessionId: chatSessionId
              })
            );
            return {
              providerId,
              settings,
              sessionId: chatSessionId,
              providerSessionId: resolveOrchestratorProviderSessionId(chatSessionId, input.providerSessionId),
              workspaceDir: agentWorkspaceDir,
              workspaceRoot: project.workspacePath,
              role: input.role,
              prompt: input.prompt,
              rolePrompt: promptBundle.rolePrompt,
              skillSegments: promptBundle.skillSegments,
              skillIds: promptBundle.skillIds,
              contextKind: "project_agent_chat",
              runtimeConstraints: ["Use task-actions for coordination changes and progress reporting."],
              sessionDirFallback: buildOrchestratorMinimaxSessionDir(paths.projectRootDir),
              apiBaseFallback: "https://api.minimax.io/v1",
              modelFallback: "MiniMax-Text-01",
              env: {
                AUTO_DEV_PROJECT_ID: projectId,
                AUTO_DEV_SESSION_ID: chatSessionId,
                AUTO_DEV_AGENT_ROLE: input.role,
                AUTO_DEV_PROJECT_ROOT: project.workspacePath,
                AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
                AUTO_DEV_MANAGER_URL: resolveOrchestratorManagerUrl()
              },
              toolInjection
            };
          }
        },
        { role, prompt, sessionId, providerSessionId }
      );
    } catch (error) {
      logger.error(`[API] POST /api/projects/${projectId}/agent-chat - error: ${error}`);
      next(error);
    }
  });

  app.post("/api/projects/:id/agent-chat/:sessionId/interrupt", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const sessionId = req.params.sessionId;

    logger.info(`[API] POST /api/projects/${projectId}/agent-chat/${sessionId}/interrupt - request received`);

    try {
      const existingSession = await getProjectSessionById(dataRoot, projectId, sessionId);
      const providerId = existingSession?.provider ?? "minimax";
      const cancelled = providerRegistry.cancelSession(providerId, sessionId);
      const duration = Date.now() - startTime;
      logger.info(
        `[API] POST /api/projects/${projectId}/agent-chat/${sessionId}/interrupt - completed in ${duration}ms, cancelled=${cancelled}`
      );

      res.json({ success: true, cancelled });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(
        `[API] POST /api/projects/${projectId}/agent-chat/${sessionId}/interrupt - error after ${duration}ms: ${error}`
      );
      next(error);
    }
  });
}
