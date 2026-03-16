import assert from "node:assert/strict";
import { test } from "node:test";
import { createSummaryMessagesTool, type SummaryMessagesBridge } from "../minimax/tools/SummaryMessagesTool.js";
import type { SummaryApplyRequest, SummaryCheckpoint } from "../minimax/types.js";

function parseContent(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

function createBridge(overrides?: Partial<SummaryMessagesBridge>): SummaryMessagesBridge {
  const checkpoints: SummaryCheckpoint[] = [
    {
      checkpointId: "ckpt-1",
      messageIndex: 1,
      role: "user",
      reason: "user_prompt",
      preview: "hello"
    }
  ];
  return {
    isDisabled: () => false,
    listCheckpoints: () => checkpoints,
    enqueueApply: (_request: SummaryApplyRequest) => ({ accepted: true, availableCheckpoints: checkpoints.length }),
    ...overrides
  };
}

test("summary_messages list returns checkpoints", async () => {
  const tool = createSummaryMessagesTool({ bridge: createBridge() });
  const result = await tool.execute({ action: "list" });
  assert.equal(result.success, true);
  const payload = parseContent(result.content);
  assert.equal(payload.action, "list");
  assert.equal(Array.isArray(payload.checkpoints), true);
  assert.equal((payload.checkpoints as unknown[]).length, 1);
});

test("summary_messages apply validates summary and keep_recent_messages", async () => {
  const tool = createSummaryMessagesTool({ bridge: createBridge() });
  const missingSummary = await tool.execute({ action: "apply", checkpoint_id: "ckpt-1" });
  assert.equal(missingSummary.success, false);
  assert.equal(missingSummary.error?.includes("SUMMARY_EMPTY"), true);

  const invalidKeep = await tool.execute({
    action: "apply",
    checkpoint_id: "ckpt-1",
    summary: "keep this",
    keep_recent_messages: 99
  });
  assert.equal(invalidKeep.success, false);
  assert.equal(invalidKeep.error?.includes("INVALID_KEEP_RECENT_MESSAGES"), true);
});

test("summary_messages apply validates checkpoint and returns accepted payload", async () => {
  let acceptedRequest: SummaryApplyRequest | null = null;
  const tool = createSummaryMessagesTool({
    bridge: createBridge({
      enqueueApply: (request) => {
        acceptedRequest = request;
        return { accepted: true, availableCheckpoints: 1 };
      }
    })
  });

  const missingCheckpoint = await tool.execute({
    action: "apply",
    checkpoint_id: "ckpt-not-exist",
    summary: "s"
  });
  assert.equal(missingCheckpoint.success, false);
  assert.equal(missingCheckpoint.error?.includes("CHECKPOINT_NOT_FOUND"), true);

  const accepted = await tool.execute({
    action: "apply",
    checkpoint_id: "ckpt-1",
    summary: "compact history",
    keep_recent_messages: 0
  });
  assert.equal(accepted.success, true);
  const payload = parseContent(accepted.content);
  assert.equal(payload.accepted, true);
  assert.equal(acceptedRequest?.checkpointId, "ckpt-1");
});

test("summary_messages respects runtime disable switch", async () => {
  const tool = createSummaryMessagesTool({
    bridge: createBridge({
      isDisabled: () => true
    })
  });
  const result = await tool.execute({ action: "list" });
  assert.equal(result.success, false);
  assert.equal(result.error?.includes("SUMMARY_APPLY_NOT_AVAILABLE"), true);
});
