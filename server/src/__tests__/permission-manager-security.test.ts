import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { PermissionManager } from "../minimax/tools/PermissionManager.js";

test("PermissionManager denies symlink escapes using realpath containment", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-permission-realpath-"));
  const workspace = path.join(tempRoot, "workspace");
  const outside = path.join(tempRoot, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");

  const linkPath = path.join(workspace, "outside-link");
  try {
    await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const manager = new PermissionManager({ workspaceDir: workspace, additionalWritableDirs: [] });
  assert.equal(manager.checkPermission(path.join(workspace, "local.txt"), "write").allowed, true);
  assert.equal(manager.checkPermission(path.join(linkPath, "secret.txt"), "read").allowed, false);
  assert.equal(manager.checkPermission(path.join(linkPath, "new.txt"), "write").allowed, false);
});
