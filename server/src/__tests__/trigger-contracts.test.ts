import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TriggerActionSchema,
  TriggerConfigCreateRequestSchema,
  TriggerPluginImportRequestSchema,
  TriggerPluginManifestSchema
} from "@autodev/agent-library";

test("trigger public contracts normalize manifest, config, import, and action payloads", () => {
  const manifest = TriggerPluginManifestSchema.parse({
    schema_version: "1.0",
    plugin_id: "hello-trigger",
    name: "Hello Trigger",
    entry: "index.ts",
    description: "Checks hello"
  });
  assert.equal(manifest.pluginId, "hello-trigger");
  assert.equal(manifest.schemaVersion, "1.0");
  assert.equal(manifest.entry, "index.ts");

  const config = TriggerConfigCreateRequestSchema.parse({
    trigger_id: "hello_every_30",
    plugin_id: "hello-trigger",
    enabled: true,
    interval_seconds: 30,
    workflow_template_id: "hello_template",
    workspace_path: "C:/workspace",
    default_variables: { message: "hello" },
    hook_timeout_ms: 1000,
    session_mode: "reuse_provider_session"
  });
  assert.equal(config.triggerId, "hello_every_30");
  assert.equal(config.pluginId, "hello-trigger");
  assert.equal(config.intervalSeconds, 30);
  assert.equal(config.sessionMode, "reuse_provider_session");
  assert.deepEqual(config.defaultVariables, { message: "hello" });

  const importPayload = TriggerPluginImportRequestSchema.parse({ source: "C:/plugins/hello" });
  assert.equal(importPayload.source, "C:/plugins/hello");

  const action = TriggerActionSchema.parse({
    should_trigger: true,
    workflow_template_id: "hello_template",
    run_name: "hello run",
    variables: { message: "hello" }
  });
  assert.equal(action.shouldTrigger, true);
  assert.equal(action.workflowTemplateId, "hello_template");
  assert.equal(action.runName, "hello run");
  assert.deepEqual(action.variables, { message: "hello" });
});
