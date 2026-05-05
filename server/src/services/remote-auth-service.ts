import type express from "express";
import type { RuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";
import { getRuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";
import { signRemoteAuthToken, verifyRemotePasswordHash } from "./remote-auth-crypto.js";

const TOKEN_TTL_SECONDS = Number(process.env.AUTO_DEV_AUTH_TOKEN_TTL_SECONDS ?? 7 * 24 * 60 * 60);

interface RemoteAuthTokenPayload {
  iat: number;
  exp: number;
  pwd: string;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function readBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function remoteAuthSecret(settings: RuntimeSettings): string | null {
  const security = settings.security;
  if (!security?.remote_password_hash || !security.remote_password_salt || !security.remote_password_updated_at) {
    return null;
  }
  return [security.remote_password_hash, security.remote_password_salt, security.remote_password_updated_at].join(":");
}

export function isRemotePasswordEnabled(settings: RuntimeSettings): boolean {
  return remoteAuthSecret(settings) !== null;
}

export function verifyRemotePassword(settings: RuntimeSettings, password: string): boolean {
  const security = settings.security;
  if (!security?.remote_password_hash || !security.remote_password_salt) {
    return false;
  }
  return verifyRemotePasswordHash(password, security.remote_password_salt, security.remote_password_hash);
}

export function issueRemoteAuthToken(settings: RuntimeSettings, now = new Date()): string | null {
  const secret = remoteAuthSecret(settings);
  if (!secret || !settings.security?.remote_password_updated_at) {
    return null;
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = base64UrlJson({
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
    pwd: settings.security.remote_password_updated_at
  } satisfies RemoteAuthTokenPayload);
  return `${payload}.${signRemoteAuthToken(payload, secret)}`;
}

export function validateRemoteAuthToken(
  settings: RuntimeSettings,
  token: string | undefined,
  now = new Date()
): boolean {
  if (!isRemotePasswordEnabled(settings)) {
    return true;
  }
  const secret = remoteAuthSecret(settings);
  const updatedAt = settings.security?.remote_password_updated_at;
  if (!secret || !updatedAt || !token) {
    return false;
  }
  const [payloadPart, signature] = token.split(".");
  if (!payloadPart || !signature) {
    return false;
  }
  const expectedSignature = signRemoteAuthToken(payloadPart, secret);
  if (signature !== expectedSignature) {
    return false;
  }
  const payload = readBase64UrlJson<RemoteAuthTokenPayload>(payloadPart);
  if (!payload || payload.pwd !== updatedAt) {
    return false;
  }
  return typeof payload.exp === "number" && payload.exp > Math.floor(now.getTime() / 1000);
}

export function extractRemoteAuthToken(req: express.Request): string | undefined {
  const explicitHeader = req.header("X-Auto-Dev-Auth-Token")?.trim();
  if (explicitHeader) {
    return explicitHeader;
  }
  const authorization = req.header("Authorization")?.trim();
  const prefix = "Bearer ";
  return authorization?.startsWith(prefix) ? authorization.slice(prefix.length).trim() : undefined;
}

export async function buildAutoDevAuthEnv(dataRoot: string): Promise<Record<string, string>> {
  const settings = await getRuntimeSettings(dataRoot);
  const token = issueRemoteAuthToken(settings);
  return token ? { AUTO_DEV_AUTH_TOKEN: token } : {};
}
