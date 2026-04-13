import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coerceShellTypeForPlatform,
  getRuntimePlatformCapabilities,
  isShellSupportedOnPlatform
} from "../runtime-platform.js";

test("runtime platform capabilities provide platform-specific shell and CLI defaults", () => {
  const windows = getRuntimePlatformCapabilities("win32", {
    ...process.env,
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming"
  });
  const linux = getRuntimePlatformCapabilities("linux");
  const mac = getRuntimePlatformCapabilities("darwin");

  assert.deepEqual(windows.supportedShells, ["powershell", "cmd"]);
  assert.equal(windows.defaultShell, "powershell");
  assert.match(windows.codexCliCommandDefault, /codex\.cmd$/i);

  assert.deepEqual(linux.supportedShells, ["bash", "sh"]);
  assert.equal(linux.defaultShell, "bash");
  assert.equal(linux.codexCliCommandDefault, "codex");

  assert.equal(mac.macosUntested, true);
  assert.deepEqual(mac.supportedShells, ["bash", "sh"]);
});

test("shell support and coercion stay platform-safe", () => {
  assert.equal(isShellSupportedOnPlatform("powershell", "win32"), true);
  assert.equal(isShellSupportedOnPlatform("bash", "win32"), false);
  assert.equal(isShellSupportedOnPlatform("bash", "linux"), true);
  assert.equal(isShellSupportedOnPlatform("cmd", "linux"), false);

  assert.equal(coerceShellTypeForPlatform("cmd", "win32"), "cmd");
  assert.equal(coerceShellTypeForPlatform("bash", "win32"), "powershell");
  assert.equal(coerceShellTypeForPlatform("powershell", "linux"), "bash");
  assert.equal(coerceShellTypeForPlatform(undefined, "darwin"), "bash");
});
