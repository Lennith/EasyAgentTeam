export interface LockRecord {
  lockId: string;
  lockKey: string;
  ownerSessionId: string;
  targetType?: "file" | "dir" | "unknown";
  purpose?: string;
  ttlSeconds: number;
  renewCount: number;
  acquiredAt: string;
  expiresAt: string;
  status: "active" | "released" | "expired";
  stealReason?: string;
  stolenFromSessionId?: string;
}
