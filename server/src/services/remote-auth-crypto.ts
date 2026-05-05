import crypto from "node:crypto";

const REMOTE_PASSWORD_ITERATIONS = 210_000;
const REMOTE_PASSWORD_KEY_LENGTH = 32;
const REMOTE_PASSWORD_DIGEST = "sha256";

export interface RemotePasswordHash {
  hash: string;
  salt: string;
}

export function hashRemotePassword(
  password: string,
  salt = crypto.randomBytes(16).toString("base64url")
): RemotePasswordHash {
  const hash = crypto
    .pbkdf2Sync(password, salt, REMOTE_PASSWORD_ITERATIONS, REMOTE_PASSWORD_KEY_LENGTH, REMOTE_PASSWORD_DIGEST)
    .toString("base64url");
  return { hash, salt };
}

export function verifyRemotePasswordHash(password: string, salt: string, expectedHash: string): boolean {
  const actual = hashRemotePassword(password, salt).hash;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expectedHash);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function signRemoteAuthToken(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}
