import { z } from "zod";

export const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" ? value.trim() || undefined : value;

export const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional()).optional();
export const requiredString = z.preprocess(emptyToUndefined, z.string().min(1));
export const nullableStringPatch = z
  .preprocess(
    (value) =>
      value === null || (typeof value === "string" && value.trim().length === 0) ? null : emptyToUndefined(value),
    z.string().min(1).nullable()
  )
  .optional();

export const optionalNullableString = z
  .preprocess((value) => (value === null ? undefined : emptyToUndefined(value)), z.string().min(1).optional())
  .optional();

export const stringArray = z
  .array(
    z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1))
  )
  .optional();

export const stringArrayFromArrayOrString = z.preprocess(
  (value) => {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return value
        .split(/[,\n\r|]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return value;
  },
  z
    .array(
      z
        .string()
        .transform((value) => value.trim())
        .pipe(z.string().min(1))
    )
    .optional()
);

export const stringMap = z.record(z.string(), z.string()).optional();
export const routeTable = z.record(z.string(), z.array(z.string())).optional();
export const routeDiscussRounds = z.record(z.string(), z.record(z.string(), z.number().int().positive())).optional();
export const unknownRecord = z.record(z.string(), z.unknown());

export const ProviderIdSchema = z.enum(["codex", "minimax", "dpagent"]);
export const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);

export function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

export function dedupeStrings(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  return Array.from(new Set(values.map((item) => item.trim()).filter((item) => item.length > 0)));
}

export function readBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

export function readInteger(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
  }
  return undefined;
}
