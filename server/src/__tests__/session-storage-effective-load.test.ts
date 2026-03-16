import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { SessionStorage } from "../minimax/storage/SessionStorage.js";
import { createPersistedMessage } from "../minimax/storage/JSONLWriter.js";

test("loadEffectiveMessages returns full history when no summary anchor exists", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-effective-a-"));
  const storage = new SessionStorage(workspaceRoot);
  const sessionId = "sess-effective-a";
  storage.createSession(sessionId);

  storage.appendMessage(sessionId, createPersistedMessage("user", "m1"));
  storage.appendMessage(sessionId, createPersistedMessage("assistant", "m2"));

  const all = storage.loadMessages(sessionId);
  const effective = storage.loadEffectiveMessages(sessionId);
  assert.equal(all.length, 2);
  assert.equal(effective.length, 2);
});

test("loadEffectiveMessages starts from latest summary anchor", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-effective-b-"));
  const storage = new SessionStorage(workspaceRoot);
  const sessionId = "sess-effective-b";
  storage.createSession(sessionId);

  storage.appendMessage(sessionId, createPersistedMessage("user", "before-1"));
  storage.appendMessage(
    sessionId,
    createPersistedMessage("user", "anchor-old", {
      metadata: {
        summaryAnchor: true,
        checkpointId: "ckpt-2",
        checkpointReason: "summary_anchor"
      }
    })
  );
  storage.appendMessage(sessionId, createPersistedMessage("assistant", "middle"));
  storage.appendMessage(
    sessionId,
    createPersistedMessage("user", "anchor-new", {
      metadata: {
        summaryAnchor: true,
        checkpointId: "ckpt-4",
        checkpointReason: "summary_anchor"
      }
    })
  );
  storage.appendMessage(sessionId, createPersistedMessage("assistant", "after-new"));

  const effective = storage.loadEffectiveMessages(sessionId);
  assert.equal(effective.length, 2);
  assert.equal(effective[0]?.content, "anchor-new");
  assert.equal(effective[1]?.content, "after-new");
});
