import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexSpawnSpec } from "../services/codex-cli-spawn.js";

test("codex spawn spec preserves args through cmd call wrapper on Windows", () => {
  const spec = buildCodexSpawnSpec("C:\\Users\\spiri\\AppData\\Roaming\\npm\\codex.cmd", [
    "exec",
    "--json",
    "-c",
    "mcp_servers.teamtool.command='C:\\Program Files\\nodejs\\node.exe'"
  ]);

  if (process.platform === "win32") {
    assert.equal(spec.shell, false);
    assert.deepEqual(spec.args.slice(0, 4), ["/d", "/c", "call", "C:\\Users\\spiri\\AppData\\Roaming\\npm\\codex.cmd"]);
    assert.equal(spec.args[spec.args.length - 1], "mcp_servers.teamtool.command='C:\\Program Files\\nodejs\\node.exe'");
    return;
  }

  assert.equal(spec.command, "C:\\Users\\spiri\\AppData\\Roaming\\npm\\codex.cmd");
  assert.deepEqual(spec.args, [
    "exec",
    "--json",
    "-c",
    "mcp_servers.teamtool.command='C:\\Program Files\\nodejs\\node.exe'"
  ]);
});
