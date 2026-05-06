import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import {
  TriggerActionSchema,
  TriggerCheckResultSchema,
  TriggerCompletionVerdictSchema,
  TriggerPluginManifestSchema,
  type TriggerAction,
  type TriggerCheckResult,
  type TriggerCompletionVerdict
} from "@autodev/agent-library";
import { ensureAgentWorkspaces } from "../agent-workspace-service.js";
import {
  createWorkflowRunForApi,
  listWorkflowCatalogAgents,
  readWorkflowRunForApi,
  readWorkflowTemplateForApi
} from "../workflow-admin-service.js";
import { buildOrchestratorAgentCatalog } from "../orchestrator/shared/index.js";
import { OrchestratorLoopCore } from "../orchestrator-core.js";
import { applyTemplateVariables, buildRolePromptMapForRoles } from "../../routes/shared/http.js";
import type { WorkflowOrchestratorService } from "../orchestrator/workflow/workflow-orchestrator.js";
import type { AgentDefinition, WorkflowRunRecord, WorkflowSessionRecord } from "../../domain/models.js";
import { logger } from "../../utils/logger.js";
import {
  appendTriggerAudit,
  clearTriggerSessionBindingActiveRun,
  createTrigger,
  deleteTrigger,
  getTriggerSessionBinding,
  getTrigger,
  getTriggerPlugin,
  listTriggerSessionBindings,
  listTriggerPlugins,
  listTriggerRunHistory,
  listTriggers,
  patchTrigger,
  replaceDirectory,
  resetTriggerSessionBindings,
  triggerPluginDataDir,
  triggerPluginPackagesRoot,
  upsertTriggerSessionBinding,
  upsertTriggerPlugin
} from "./trigger-repository.js";
import { TriggerPluginRunner } from "./trigger-plugin-runner.js";
import type {
  TriggerConfigRecord,
  TriggerExecutionContext,
  TriggerExecutionResult,
  TriggerPluginRecord,
  TriggerSessionBindingRecord
} from "./trigger-types.js";

export interface TriggerRuntimeOptions {
  enabled: boolean;
  intervalMs: number;
}

export interface ImportTriggerPluginInput {
  source: string;
}

export interface CreateTriggerInput {
  triggerId: string;
  pluginId: string;
  enabled: boolean;
  intervalSeconds: number;
  workflowTemplateId: string;
  workspacePath: string;
  defaultVariables?: Record<string, string>;
  hookTimeoutMs: number;
  sessionMode: TriggerConfigRecord["sessionMode"];
}

function resolveBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return fallback;
}

function resolveIntervalMs(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
}

export function resolveTriggerRuntimeOptionsFromEnv(): TriggerRuntimeOptions {
  return {
    enabled: resolveBooleanEnv(process.env.TRIGGER_RUNTIME_ENABLED, true),
    intervalMs: resolveIntervalMs(process.env.TRIGGER_RUNTIME_INTERVAL_MS, 10_000)
  };
}

function pluginPackageDirName(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function assertInside(parent: string, child: string): void {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const relative = path.relative(parentResolved, childResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes trigger plugin package: ${child}`);
  }
}

function resolvePluginEntryPath(packageDir: string, entry: string): string {
  const entryPath = path.resolve(packageDir, entry);
  assertInside(packageDir, entryPath);
  return entryPath;
}

function buildTriggerContext(
  dataRoot: string,
  trigger: TriggerConfigRecord,
  plugin: TriggerPluginRecord,
  manual: boolean
): TriggerExecutionContext {
  return {
    trigger: {
      ...trigger,
      trigger_id: trigger.triggerId,
      plugin_id: trigger.pluginId,
      workflow_template_id: trigger.workflowTemplateId,
      workspace_path: trigger.workspacePath,
      session_mode: trigger.sessionMode
    },
    plugin,
    dataDir: triggerPluginDataDir(dataRoot, plugin.pluginId, trigger.triggerId),
    workspacePath: trigger.workspacePath,
    defaultVariables: trigger.defaultVariables ?? {},
    now: new Date().toISOString(),
    manual
  };
}

function resolveAgentProvider(agent: AgentDefinition | undefined): "codex" | "minimax" | "dpagent" | undefined {
  const provider = agent?.defaultCliTool;
  return provider === "codex" || provider === "minimax" || provider === "dpagent" ? provider : undefined;
}

export class TriggerRuntimeService {
  private readonly runner = new TriggerPluginRunner();
  private readonly loopCore: OrchestratorLoopCore;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly dataRoot: string,
    private readonly workflowOrchestrator: WorkflowOrchestratorService,
    options: TriggerRuntimeOptions
  ) {
    this.loopCore = new OrchestratorLoopCore({
      enabled: options.enabled,
      intervalMs: options.intervalMs,
      onTick: async () => {
        await this.tickTriggers();
      },
      onError: (error) => {
        logger.error(`[trigger-runtime] tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  start(): void {
    this.loopCore.start();
  }

  stop(): void {
    this.loopCore.stop();
  }

  listPlugins(): Promise<TriggerPluginRecord[]> {
    return listTriggerPlugins(this.dataRoot);
  }

  listTriggers(): Promise<TriggerConfigRecord[]> {
    return listTriggers(this.dataRoot);
  }

  listRuns(triggerId: string) {
    return listTriggerRunHistory(this.dataRoot, triggerId);
  }

  listSessionBindings(triggerId: string): Promise<TriggerSessionBindingRecord[]> {
    return listTriggerSessionBindings(this.dataRoot, triggerId);
  }

  async resetSessionBindings(
    triggerId: string,
    filter: { role?: string; provider?: string } = {}
  ): Promise<TriggerSessionBindingRecord[]> {
    const removed = await resetTriggerSessionBindings(this.dataRoot, triggerId, filter);
    await appendTriggerAudit(this.dataRoot, {
      eventType: "TRIGGER_SESSION_BINDING_RESET",
      triggerId,
      payload: {
        role: filter.role ?? null,
        provider: filter.provider ?? null,
        removedCount: removed.length
      }
    });
    return removed;
  }

  async importPlugin(input: ImportTriggerPluginInput): Promise<TriggerPluginRecord> {
    const sourceDir = path.resolve(input.source);
    const stat = await fs.stat(sourceDir);
    if (!stat.isDirectory()) {
      throw new Error("trigger plugin source must be a directory");
    }
    const manifestPath = path.join(sourceDir, "trigger.plugin.yaml");
    const rawManifest = await fs.readFile(manifestPath, "utf8");
    const parsedManifest = TriggerPluginManifestSchema.parse(yaml.load(rawManifest));
    if (parsedManifest.schemaVersion !== "1.0") {
      throw new Error("trigger plugin schema_version must be 1.0");
    }
    const sourceEntryPath = resolvePluginEntryPath(sourceDir, parsedManifest.entry);
    await fs.access(sourceEntryPath);
    const validation = await this.runner.validate(sourceEntryPath, 5000);
    if (!validation.doCheck || !validation.onCheckResult) {
      throw new Error("trigger plugin must export doCheck and onCheckResult");
    }

    const targetDir = path.join(
      triggerPluginPackagesRoot(this.dataRoot),
      pluginPackageDirName(parsedManifest.pluginId)
    );
    await replaceDirectory(sourceDir, targetDir);
    const plugin = await upsertTriggerPlugin(this.dataRoot, {
      pluginId: parsedManifest.pluginId,
      name: parsedManifest.name,
      description: parsedManifest.description,
      entry: parsedManifest.entry,
      sourcePath: sourceDir,
      packagePath: path.relative(path.join(this.dataRoot, "triggers"), targetDir).replace(/\\/g, "/"),
      hasCompletionHook: validation.hasCompletionHook
    });
    await appendTriggerAudit(this.dataRoot, {
      eventType: "TRIGGER_PLUGIN_IMPORTED",
      pluginId: plugin.pluginId,
      payload: { sourcePath: sourceDir, packagePath: plugin.packagePath }
    });
    return plugin;
  }

  createTrigger(input: CreateTriggerInput): Promise<TriggerConfigRecord> {
    return createTrigger(this.dataRoot, input);
  }

  patchTrigger(triggerId: string, patch: Parameters<typeof patchTrigger>[2]): Promise<TriggerConfigRecord> {
    return patchTrigger(this.dataRoot, triggerId, patch);
  }

  deleteTrigger(triggerId: string): Promise<TriggerConfigRecord> {
    return deleteTrigger(this.dataRoot, triggerId);
  }

  async testTrigger(triggerId: string): Promise<TriggerExecutionResult> {
    const trigger = await getTrigger(this.dataRoot, triggerId);
    if (!trigger) {
      throw new Error(`trigger '${triggerId}' not found`);
    }
    await this.checkWorkflowCompletions();
    return this.executeTrigger(trigger, true);
  }

  async tickTriggers(now: Date = new Date()): Promise<void> {
    await this.checkWorkflowCompletions();
    const triggers = await listTriggers(this.dataRoot);
    for (const trigger of triggers) {
      if (!trigger.enabled || this.inFlight.has(trigger.triggerId)) {
        continue;
      }
      if (trigger.nextCheckAt && Date.parse(trigger.nextCheckAt) > now.getTime()) {
        continue;
      }
      await this.executeTrigger(trigger, false).catch((error) => {
        logger.error(
          `[trigger-runtime] trigger '${trigger.triggerId}' failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }
  }

  private resolvePackageDir(plugin: TriggerPluginRecord): string {
    const triggerRoot = path.join(this.dataRoot, "triggers");
    const packageDir = path.resolve(triggerRoot, plugin.packagePath);
    assertInside(triggerRoot, packageDir);
    return packageDir;
  }

  private async executeTrigger(trigger: TriggerConfigRecord, manual: boolean): Promise<TriggerExecutionResult> {
    const plugin = await getTriggerPlugin(this.dataRoot, trigger.pluginId);
    if (!plugin) {
      throw new Error(`trigger plugin '${trigger.pluginId}' not found`);
    }
    const fireId = `trigger-fire-${randomUUID()}`;
    this.inFlight.add(trigger.triggerId);
    await appendTriggerAudit(this.dataRoot, {
      eventType: "TRIGGER_CHECK_STARTED",
      triggerId: trigger.triggerId,
      pluginId: plugin.pluginId,
      fireId,
      payload: { manual }
    });
    try {
      const activeRunId = await this.findActiveReuseWorkflowRun(trigger);
      if (activeRunId) {
        const reason = `session_binding_busy:${activeRunId}`;
        await this.markSkipped(trigger, plugin, fireId, reason);
        return this.finishExecution(trigger, {
          status: "skipped",
          fireId,
          triggerId: trigger.triggerId,
          pluginId: plugin.pluginId,
          reason
        });
      }
      await fs.mkdir(triggerPluginDataDir(this.dataRoot, plugin.pluginId, trigger.triggerId), { recursive: true });
      const context = buildTriggerContext(this.dataRoot, trigger, plugin, manual);
      const entryPath = resolvePluginEntryPath(this.resolvePackageDir(plugin), plugin.entry);
      const checkRaw = await this.runner.runHook<unknown>(entryPath, "doCheck", [context], trigger.hookTimeoutMs);
      const checkResult = TriggerCheckResultSchema.parse(checkRaw);
      if (!checkResult.needTrigger) {
        await this.markSkipped(trigger, plugin, fireId, checkResult.reason ?? "doCheck returned need_trigger=false");
        return this.finishExecution(trigger, {
          status: "skipped",
          fireId,
          triggerId: trigger.triggerId,
          pluginId: plugin.pluginId,
          checkResult,
          reason: checkResult.reason
        });
      }
      const actionRaw = await this.runner.runHook<unknown>(
        entryPath,
        "onCheckResult",
        [context, checkResult],
        trigger.hookTimeoutMs
      );
      if (actionRaw === null || actionRaw === undefined) {
        await this.markSkipped(trigger, plugin, fireId, "onCheckResult returned no action");
        return this.finishExecution(trigger, {
          status: "skipped",
          fireId,
          triggerId: trigger.triggerId,
          pluginId: plugin.pluginId,
          checkResult,
          reason: "onCheckResult returned no action"
        });
      }
      const action = TriggerActionSchema.parse(actionRaw);
      if (!action.shouldTrigger) {
        await this.markSkipped(trigger, plugin, fireId, action.reason ?? "onCheckResult returned should_trigger=false");
        return this.finishExecution(trigger, {
          status: "skipped",
          fireId,
          triggerId: trigger.triggerId,
          pluginId: plugin.pluginId,
          checkResult,
          action,
          reason: action.reason
        });
      }
      let workflowRunId: string;
      try {
        workflowRunId = await this.createAndStartWorkflowRun(trigger, fireId, action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendTriggerAudit(this.dataRoot, {
          eventType: "TRIGGER_WORKFLOW_RUN_START_FAILED",
          triggerId: trigger.triggerId,
          pluginId: plugin.pluginId,
          fireId,
          payload: { error: message, reason: action.reason ?? checkResult.reason ?? null }
        });
        return this.finishExecution(trigger, {
          status: "failed",
          fireId,
          triggerId: trigger.triggerId,
          pluginId: plugin.pluginId,
          checkResult,
          action,
          error: message
        });
      }
      await appendTriggerAudit(this.dataRoot, {
        eventType: "TRIGGER_WORKFLOW_RUN_CREATED",
        triggerId: trigger.triggerId,
        pluginId: plugin.pluginId,
        fireId,
        payload: { workflowRunId, reason: action.reason ?? checkResult.reason ?? null }
      });
      return this.finishExecution(trigger, {
        status: "fired",
        fireId,
        triggerId: trigger.triggerId,
        pluginId: plugin.pluginId,
        checkResult,
        action,
        workflowRunId,
        reason: action.reason ?? checkResult.reason
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendTriggerAudit(this.dataRoot, {
        eventType: "TRIGGER_HOOK_FAILED",
        triggerId: trigger.triggerId,
        pluginId: plugin.pluginId,
        fireId,
        payload: { error: message }
      });
      return this.finishExecution(trigger, {
        status: "failed",
        fireId,
        triggerId: trigger.triggerId,
        pluginId: plugin.pluginId,
        error: message
      });
    } finally {
      this.inFlight.delete(trigger.triggerId);
    }
  }

  private async finishExecution(
    trigger: TriggerConfigRecord,
    result: TriggerExecutionResult
  ): Promise<TriggerExecutionResult> {
    const checkedAt = new Date().toISOString();
    const nextCheckAt = new Date(Date.now() + trigger.intervalSeconds * 1000).toISOString();
    await patchTrigger(this.dataRoot, trigger.triggerId, {
      lastCheckedAt: checkedAt,
      nextCheckAt,
      lastFireId: result.status === "fired" ? result.fireId : trigger.lastFireId
    });
    return result;
  }

  private async markSkipped(
    trigger: TriggerConfigRecord,
    plugin: TriggerPluginRecord,
    fireId: string,
    reason: string
  ): Promise<void> {
    await appendTriggerAudit(this.dataRoot, {
      eventType: "TRIGGER_CHECK_SKIPPED",
      triggerId: trigger.triggerId,
      pluginId: plugin.pluginId,
      fireId,
      payload: { reason }
    });
  }

  private isReuseProviderSession(trigger: TriggerConfigRecord): boolean {
    return trigger.sessionMode === "reuse_provider_session";
  }

  private isWorkflowRunTerminal(run: { status: string } | null): boolean {
    return run?.status === "finished" || run?.status === "failed";
  }

  private async findActiveReuseWorkflowRun(trigger: TriggerConfigRecord): Promise<string | null> {
    if (!this.isReuseProviderSession(trigger)) {
      return null;
    }
    const bindings = await listTriggerSessionBindings(this.dataRoot, trigger.triggerId);
    for (const binding of bindings) {
      if (!binding.activeWorkflowRunId) {
        continue;
      }
      const run = await readWorkflowRunForApi(this.dataRoot, binding.activeWorkflowRunId);
      if (run && !this.isWorkflowRunTerminal(run)) {
        return binding.activeWorkflowRunId;
      }
      if (run && this.isWorkflowRunTerminal(run)) {
        await this.processCompletedWorkflowFire(trigger, binding.activeFireId, run);
      } else {
        await clearTriggerSessionBindingActiveRun(this.dataRoot, trigger.triggerId, binding.activeWorkflowRunId);
      }
    }

    const history = await listTriggerRunHistory(this.dataRoot, trigger.triggerId);
    for (const item of history) {
      if (item.status !== "fired" || !item.workflowRunId) {
        continue;
      }
      const run = await readWorkflowRunForApi(this.dataRoot, item.workflowRunId);
      if (run && !this.isWorkflowRunTerminal(run)) {
        return item.workflowRunId;
      }
    }
    return null;
  }

  private async createAndStartWorkflowRun(
    trigger: TriggerConfigRecord,
    fireId: string,
    action: TriggerAction
  ): Promise<string> {
    const templateId = action.workflowTemplateId ?? trigger.workflowTemplateId;
    const template = await readWorkflowTemplateForApi(this.dataRoot, templateId);
    if (!template) {
      throw new Error(`workflow template '${templateId}' not found`);
    }
    const variables = {
      ...(trigger.defaultVariables ?? {}),
      ...(action.variables ?? {})
    };
    const mergedVariables = {
      ...(template.defaultVariables ?? {}),
      ...variables
    };
    const taskOverrides = action.taskOverrides;
    const tasks = template.tasks.map((task) => {
      const baseTitle = taskOverrides?.[task.taskId] ?? task.title;
      return {
        ...task,
        resolvedTitle: applyTemplateVariables(baseTitle, mergedVariables)
      };
    });
    const runId = `trigger-run-${randomUUID().slice(0, 12)}`;
    const created = await createWorkflowRunForApi(this.dataRoot, {
      runId,
      templateId: template.templateId,
      name: action.runName ?? `${trigger.triggerId}-${fireId.slice(-6)}`,
      description: action.description ?? `Triggered by ${trigger.triggerId}`,
      workspacePath: action.workspacePath ?? trigger.workspacePath,
      routeTable: template.routeTable,
      taskAssignRouteTable: template.taskAssignRouteTable,
      routeDiscussRounds: template.routeDiscussRounds,
      variables: mergedVariables,
      taskOverrides,
      tasks,
      mode: "none",
      loopEnabled: false,
      scheduleEnabled: false,
      autoDispatchEnabled: true,
      autoDispatchRemaining: action.autoDispatchRemaining ?? 5,
      autoDispatchInitialRemaining: action.autoDispatchRemaining ?? 5,
      holdEnabled: false,
      reminderMode: "backoff"
    });
    const agents = await listWorkflowCatalogAgents(this.dataRoot);
    const agentCatalog = buildOrchestratorAgentCatalog(agents);
    const runRoles = Array.from(new Set(created.tasks.map((task) => task.ownerRole.trim()).filter(Boolean)));
    const rolePromptMap = buildRolePromptMapForRoles(runRoles, agents);
    try {
      await ensureAgentWorkspaces(
        {
          schemaVersion: "1.0",
          projectId: `workflow-${created.runId}`,
          name: created.name,
          workspacePath: created.workspacePath,
          agentIds: runRoles,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt
        },
        rolePromptMap,
        runRoles,
        agentCatalog.roleSummaryMap
      );
      await this.registerWorkflowSessions(created.runId, runRoles, agents, trigger, template.templateId, fireId);
      await this.workflowOrchestrator.startRun(created.runId);
    } catch (error) {
      await clearTriggerSessionBindingActiveRun(this.dataRoot, trigger.triggerId, created.runId);
      throw error;
    }
    return created.runId;
  }

  private async registerWorkflowSessions(
    runId: string,
    runRoles: string[],
    agents: AgentDefinition[],
    trigger: TriggerConfigRecord,
    workflowTemplateId: string,
    fireId: string
  ): Promise<void> {
    const agentById = new Map(agents.map((agent) => [agent.agentId, agent]));
    for (const role of runRoles) {
      const provider = resolveAgentProvider(agentById.get(role));
      if (!provider) {
        continue;
      }
      const binding = this.isReuseProviderSession(trigger)
        ? await getTriggerSessionBinding(this.dataRoot, {
            triggerId: trigger.triggerId,
            workflowTemplateId,
            role,
            provider
          })
        : null;
      await this.workflowOrchestrator.registerRunSession(runId, {
        role,
        provider,
        providerSessionId: binding?.providerSessionId
      });
      if (this.isReuseProviderSession(trigger)) {
        const updated = await upsertTriggerSessionBinding(this.dataRoot, {
          triggerId: trigger.triggerId,
          workflowTemplateId,
          role,
          provider,
          providerSessionId: binding?.providerSessionId,
          activeFireId: fireId,
          activeWorkflowRunId: runId,
          lastFireId: fireId,
          lastWorkflowRunId: runId
        });
        await appendTriggerAudit(this.dataRoot, {
          eventType: "TRIGGER_SESSION_BINDING_UPDATED",
          triggerId: trigger.triggerId,
          fireId,
          payload: {
            bindingId: updated.bindingId,
            role,
            provider,
            workflowTemplateId,
            workflowRunId: runId,
            providerSessionId: updated.providerSessionId ?? null,
            active: true
          }
        });
      }
    }
  }

  private async checkWorkflowCompletions(): Promise<void> {
    const triggers = await listTriggers(this.dataRoot);
    for (const trigger of triggers) {
      const plugin = await getTriggerPlugin(this.dataRoot, trigger.pluginId);
      if (!plugin) {
        continue;
      }
      const history = await listTriggerRunHistory(this.dataRoot, trigger.triggerId);
      for (const item of history) {
        if (item.status !== "fired" || !item.workflowRunId) {
          continue;
        }
        const run = await readWorkflowRunForApi(this.dataRoot, item.workflowRunId);
        if (!run || (run.status !== "finished" && run.status !== "failed")) {
          continue;
        }
        await this.processCompletedWorkflowFire(trigger, item.fireId, run, plugin);
      }
    }
  }

  private async processCompletedWorkflowFire(
    trigger: TriggerConfigRecord,
    fireId: string | undefined,
    run: WorkflowRunRecord,
    knownPlugin?: TriggerPluginRecord
  ): Promise<void> {
    const history = await listTriggerRunHistory(this.dataRoot, trigger.triggerId);
    const historyItem = history.find((item) => item.workflowRunId === run.runId);
    const historyFireId = fireId ?? historyItem?.fireId;
    if (!historyFireId || historyItem?.status !== "fired" || (run.status !== "finished" && run.status !== "failed")) {
      await clearTriggerSessionBindingActiveRun(this.dataRoot, trigger.triggerId, run.runId);
      return;
    }
    const plugin = knownPlugin ?? (await getTriggerPlugin(this.dataRoot, trigger.pluginId));
    if (!plugin) {
      await clearTriggerSessionBindingActiveRun(this.dataRoot, trigger.triggerId, run.runId);
      return;
    }
    await this.persistWorkflowSessionBindings(trigger, historyFireId, run);
    await this.completeFire(trigger, plugin, historyFireId, run.runId, run.status);
  }

  private resolveProviderSessionIdForBinding(session: WorkflowSessionRecord): string | undefined {
    if (session.provider === "minimax") {
      return session.providerSessionId?.trim() || session.sessionId;
    }
    if (session.provider === "codex" || session.provider === "dpagent") {
      return session.providerSessionId?.trim() || undefined;
    }
    return undefined;
  }

  private async persistWorkflowSessionBindings(
    trigger: TriggerConfigRecord,
    fireId: string,
    run: WorkflowRunRecord
  ): Promise<void> {
    if (!this.isReuseProviderSession(trigger)) {
      await clearTriggerSessionBindingActiveRun(this.dataRoot, trigger.triggerId, run.runId);
      return;
    }
    const sessions = await this.workflowOrchestrator.listRunSessions(run.runId).catch(() => ({ items: [] }));
    for (const session of sessions.items) {
      const providerSessionId = this.resolveProviderSessionIdForBinding(session);
      const updated = await upsertTriggerSessionBinding(this.dataRoot, {
        triggerId: trigger.triggerId,
        workflowTemplateId: run.templateId,
        role: session.role,
        provider: session.provider,
        providerSessionId,
        activeFireId: null,
        activeWorkflowRunId: null,
        lastFireId: fireId,
        lastWorkflowRunId: run.runId
      });
      await appendTriggerAudit(this.dataRoot, {
        eventType: "TRIGGER_SESSION_BINDING_UPDATED",
        triggerId: trigger.triggerId,
        fireId,
        payload: {
          bindingId: updated.bindingId,
          role: session.role,
          provider: session.provider,
          workflowTemplateId: run.templateId,
          workflowRunId: run.runId,
          providerSessionId: updated.providerSessionId ?? null,
          active: false
        }
      });
    }
    await clearTriggerSessionBindingActiveRun(this.dataRoot, trigger.triggerId, run.runId);
  }

  private async completeFire(
    trigger: TriggerConfigRecord,
    plugin: TriggerPluginRecord,
    fireId: string,
    workflowRunId: string,
    status: "finished" | "failed"
  ): Promise<void> {
    let verdict: TriggerCompletionVerdict = {
      accepted: status === "finished",
      summary: status,
      reason: undefined,
      payload: undefined
    };
    if (plugin.hasCompletionHook) {
      try {
        const context = buildTriggerContext(this.dataRoot, trigger, plugin, false);
        const entryPath = resolvePluginEntryPath(this.resolvePackageDir(plugin), plugin.entry);
        const rawVerdict = await this.runner.runHook<unknown>(
          entryPath,
          "onWorkflowCompleted",
          [context, { runId: workflowRunId, run_id: workflowRunId, status, fireId, fire_id: fireId }],
          trigger.hookTimeoutMs
        );
        verdict = TriggerCompletionVerdictSchema.parse(rawVerdict);
      } catch (error) {
        await appendTriggerAudit(this.dataRoot, {
          eventType: "TRIGGER_COMPLETION_HOOK_FAILED",
          triggerId: trigger.triggerId,
          pluginId: plugin.pluginId,
          fireId,
          payload: {
            workflowRunId,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        await appendTriggerAudit(this.dataRoot, {
          eventType: "TRIGGER_WORKFLOW_COMPLETION_FAILED",
          triggerId: trigger.triggerId,
          pluginId: plugin.pluginId,
          fireId,
          payload: {
            workflowRunId,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        return;
      }
    }
    await appendTriggerAudit(this.dataRoot, {
      eventType: "TRIGGER_WORKFLOW_COMPLETED",
      triggerId: trigger.triggerId,
      pluginId: plugin.pluginId,
      fireId,
      payload: { workflowRunId, status, verdict }
    });
  }
}

export function createTriggerRuntimeService(
  dataRoot: string,
  workflowOrchestrator: WorkflowOrchestratorService
): TriggerRuntimeService {
  return new TriggerRuntimeService(dataRoot, workflowOrchestrator, resolveTriggerRuntimeOptionsFromEnv());
}
