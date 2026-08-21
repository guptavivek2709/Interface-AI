import { z } from "zod";
import type { CapabilityCatalogEntry } from "../catalog/index.js";
import type { FieldSpecV2, TypeSpecV2 } from "../domain/index.js";
import type { ChatToolDefinition } from "./contracts.js";

const SECRET_NAME = /(?:password|passcode|secret|token|cookie|authorization|credential)/iu;

function v2TypeSchema(type: TypeSpecV2): z.ZodType {
  if (type.kind === "string") {
    let schema = z.string();
    if (type.minLength !== undefined) schema = schema.min(type.minLength);
    if (type.maxLength !== undefined) schema = schema.max(type.maxLength);
    if (type.pattern !== undefined) schema = schema.regex(new RegExp(type.pattern, "u"));
    if (type.format === "email") schema = schema.email();
    if (type.enum !== undefined) return z.enum(type.enum as [string, ...string[]]);
    return schema;
  }
  if (type.kind === "number") {
    let schema = z.number().finite();
    if (type.integer === true) schema = schema.int();
    if (type.minimum !== undefined) schema = schema.min(type.minimum);
    if (type.maximum !== undefined) schema = schema.max(type.maximum);
    return schema;
  }
  if (type.kind === "boolean") return z.boolean();
  if (type.kind === "money") {
    return z
      .string()
      .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u)
      .refine((value) => {
        const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(value);
        if (!match) return false;
        const fraction = (match[3] ?? "").padEnd(2, "0");
        const minorUnits =
          (Number(match[2]) * 100 + Number(fraction)) * (match[1] === "-" ? -1 : 1);
        if (!Number.isSafeInteger(minorUnits)) return false;
        if (type.minimumMinorUnits !== undefined && minorUnits < type.minimumMinorUnits) return false;
        if (type.maximumMinorUnits !== undefined && minorUnits > type.maximumMinorUnits) return false;
        return true;
      }, `${type.currency} decimal amount is outside its allowed range`);
  }
  if (type.kind === "array") {
    let schema = z.array(v2TypeSchema(type.items));
    if (type.maxItems !== undefined) schema = schema.max(type.maxItems);
    return schema;
  }
  const shape: Record<string, z.ZodType> = Object.create(null) as Record<string, z.ZodType>;
  const required = new Set(type.required);
  for (const [name, property] of Object.entries(type.properties)) {
    const schema = v2TypeSchema(property);
    shape[name] = required.has(name) ? schema : schema.optional();
  }
  return z.object(shape).strict();
}

function v2InputSchema(fields: readonly FieldSpecV2[]): z.ZodType {
  const shape: Record<string, z.ZodType> = Object.create(null) as Record<string, z.ZodType>;
  for (const field of fields) {
    let schema = v2TypeSchema(field.type).describe(field.description);
    if (!field.required) schema = schema.optional();
    shape[field.name] = schema;
  }
  return z.object(shape).strict();
}

function v2OutputSchema(fields: readonly FieldSpecV2[]): z.ZodType {
  const shape: Record<string, z.ZodType> = Object.create(null) as Record<string, z.ZodType>;
  for (const field of fields) {
    shape[field.name] = v2TypeSchema(field.type).describe(field.description);
  }
  return z.object(shape).strict();
}

/**
 * Projects an approved catalog entry into a model-visible tool. Capabilities
 * that require authentication material are deliberately excluded; session
 * establishment belongs to the secure, non-model UI/API path.
 */
export function catalogEntryToChatTool(entry: CapabilityCatalogEntry): ChatToolDefinition | undefined {
  if (entry.metadata.approval !== "approved") return undefined;
  if (
    entry.artifact.inputs.some(
      (field) =>
        SECRET_NAME.test(field.name) || field.classification === "secret",
    )
  ) {
    return undefined;
  }
  const inputSchema = v2InputSchema(entry.artifact.inputs as readonly FieldSpecV2[]);
  const outputSchema = v2OutputSchema(entry.artifact.outputs as readonly FieldSpecV2[]);
  return {
    name: entry.metadata.id.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64),
    capabilityId: entry.metadata.id,
    capabilityVersion: entry.metadata.version,
    description: entry.artifact.capability.description,
    inputSchema,
    outputSchema,
  };
}

export function catalogToChatTools(entries: readonly CapabilityCatalogEntry[]): readonly ChatToolDefinition[] {
  const tools = entries.map(catalogEntryToChatTool).filter((tool): tool is ChatToolDefinition => tool !== undefined);
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Catalog capabilities collide on chat tool name ${tool.name}`);
    names.add(tool.name);
  }
  return tools;
}
