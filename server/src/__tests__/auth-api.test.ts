import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("remote password gate is disabled by default and enabled after setting password", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-auth-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot, autoStartLoops: false });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const statusBefore = await fetch(`${baseUrl}/api/auth/status`);
    assert.equal(statusBefore.status, 200);
    assert.deepEqual(await statusBefore.json(), { remote_password_enabled: false, authenticated: true });

    const settingsBefore = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsBefore.status, 200);

    const setPassword = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ security: { remote_password: "secret-pass" } })
    });
    assert.equal(setPassword.status, 200);
    const setPayload = (await setPassword.json()) as { security?: { remote_password_enabled?: boolean } };
    assert.equal(setPayload.security?.remote_password_enabled, true);
    assert.equal(JSON.stringify(setPayload).includes("secret-pass"), false);
    assert.equal(JSON.stringify(setPayload).includes("remote_password_hash"), false);

    const blocked = await fetch(`${baseUrl}/api/settings`);
    assert.equal(blocked.status, 401);

    const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" })
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret-pass" })
    });
    assert.equal(login.status, 200);
    const loginPayload = (await login.json()) as { token?: string; remote_password_enabled?: boolean };
    assert.equal(typeof loginPayload.token, "string");
    assert.equal(loginPayload.remote_password_enabled, true);

    const authorized = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${loginPayload.token}` }
    });
    assert.equal(authorized.status, 200);

    const changePassword = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginPayload.token}` },
      body: JSON.stringify({ security: { remote_password: "next-pass" } })
    });
    assert.equal(changePassword.status, 200);

    const staleToken = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${loginPayload.token}` }
    });
    assert.equal(staleToken.status, 401);

    const nextLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "next-pass" })
    });
    assert.equal(nextLogin.status, 200);
    const nextLoginPayload = (await nextLogin.json()) as { token?: string };
    assert.equal(typeof nextLoginPayload.token, "string");

    const clearPassword = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Auto-Dev-Auth-Token": nextLoginPayload.token! },
      body: JSON.stringify({ security: { remote_password: null } })
    });
    assert.equal(clearPassword.status, 200);
    const clearPayload = (await clearPassword.json()) as { security?: { remote_password_enabled?: boolean } };
    assert.equal(clearPayload.security?.remote_password_enabled, false);
    assert.equal(JSON.stringify(clearPayload).includes("remote_password_hash"), false);

    const settingsAfterClear = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsAfterClear.status, 200);
    const statusAfterClear = await fetch(`${baseUrl}/api/auth/status`);
    assert.deepEqual(await statusAfterClear.json(), { remote_password_enabled: false, authenticated: true });
  } finally {
    await serverHandle.close();
  }
});
