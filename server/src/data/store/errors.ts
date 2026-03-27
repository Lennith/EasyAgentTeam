export type StoreErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "IO_ERROR"
  | "CORRUPTED"
  | "TRANSACTION_ERROR";

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly code: StoreErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "StoreError";
  }
}

