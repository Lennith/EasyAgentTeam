import { z } from "zod";

type ZodLiteralValue = string | number | boolean | bigint | null | undefined;

type JsonSchemaLike = {
  description?: unknown;
  enum?: unknown;
  items?: unknown;
  properties?: unknown;
  required?: unknown;
  type?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDescription(schema: JsonSchemaLike): string | undefined {
  return typeof schema.description === "string" && schema.description.trim().length > 0
    ? schema.description.trim()
    : undefined;
}

function withDescription<T extends z.ZodTypeAny>(schema: T, description: string | undefined): T {
  return description ? schema.describe(description) : schema;
}

function normalizeTypes(typeValue: unknown): string[] {
  if (typeof typeValue === "string" && typeValue.trim().length > 0) {
    return [typeValue.trim()];
  }
  if (!Array.isArray(typeValue)) {
    return [];
  }
  return typeValue
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function buildEnumSchema(values: unknown[]): z.ZodTypeAny {
  const literalValues = values.filter(
    (value): value is ZodLiteralValue =>
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
  );
  if (literalValues.length === 0) {
    return z.any();
  }
  const literalSchemas = literalValues.map((value) => z.literal(value));
  if (literalSchemas.length === 1) {
    return literalSchemas[0];
  }
  return z.union([literalSchemas[0], literalSchemas[1], ...literalSchemas.slice(2)]);
}

function buildObjectSchema(schema: JsonSchemaLike): z.ZodTypeAny {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : []
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, child] of Object.entries(properties)) {
    const built = buildTeamToolInputSchema(child);
    shape[key] = required.has(key) ? built : built.optional();
  }
  return z.object(shape);
}

function buildArraySchema(schema: JsonSchemaLike): z.ZodTypeAny {
  const itemSchema = schema.items ? buildTeamToolInputSchema(schema.items) : z.string();
  return z.array(itemSchema);
}

function buildSingleTypeSchema(typeName: string, schema: JsonSchemaLike): z.ZodTypeAny {
  switch (typeName) {
    case "string":
      if (Array.isArray(schema.enum)) {
        return buildEnumSchema(schema.enum);
      }
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return buildArraySchema(schema);
    case "object":
      return buildObjectSchema(schema);
    default:
      return z.any();
  }
}

export function buildTeamToolInputSchema(schemaLike: unknown): z.ZodTypeAny {
  const schema = isRecord(schemaLike) ? (schemaLike as JsonSchemaLike) : {};
  const description = readDescription(schema);
  const types = normalizeTypes(schema.type);
  const variants = types.map((typeName) => buildSingleTypeSchema(typeName, schema));

  if (variants.length === 0) {
    if (Array.isArray(schema.enum)) {
      return withDescription(buildEnumSchema(schema.enum), description);
    }
    return withDescription(z.any(), description);
  }
  if (variants.length === 1) {
    return withDescription(variants[0], description);
  }
  return withDescription(z.union([variants[0], variants[1], ...variants.slice(2)]), description);
}
