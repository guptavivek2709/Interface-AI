import { z } from "zod";
import {
  ChatRoutingError,
  type ChatRouteRequest,
  type ChatTextMessage,
  type ChatToolDefinition,
  type JsonObject,
  type JsonValue,
} from "./contracts.js";

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;
const SECRET_FIELD_PATTERN =
  /(?:password|passwd|passcode|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|csrf|cookie|authorization|private[-_]?key)/iu;
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
  /\bsk-ant-[a-zA-Z0-9_-]{10,}\b/gu,
  /\bBearer\s+[a-zA-Z0-9._~+/-]+={0,2}/giu,
  /\b(?:password|passwd|passcode|pin|secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|authorization|cookie)\b\s*(?:=|:|\bis\b)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
  /https?:\/\/[^:/\s]+:[^@\s/]+@/giu,
];

const MAX_MESSAGE_CHARACTERS = 8_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_TOTAL_MESSAGE_CHARACTERS = 64_000;
const MAX_TOOLS = 64;
const MAX_JSON_DEPTH = 32;

export interface PreparedChatTool {
  readonly definition: ChatToolDefinition;
  readonly jsonSchema: JsonObject;
}

export interface PreparedChatRouteRequest {
  readonly message: string;
  readonly history: readonly ChatTextMessage[];
  readonly tools: readonly PreparedChatTool[];
  readonly secrets: readonly string[];
  readonly currentMessageContainedSecret: boolean;
}

function routingError(
  code: ConstructorParameters<typeof ChatRoutingError>[0],
  message: string,
  cause?: unknown,
): ChatRoutingError {
  return new ChatRoutingError(code, message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function jsonClone(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw routingError("INVALID_TOOL_INPUT", "Tool input exceeds the maximum nesting depth");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw routingError("INVALID_TOOL_INPUT", "Tool input must contain finite JSON numbers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonClone(item, depth + 1));
  if (!isRecord(value)) {
    throw routingError("INVALID_TOOL_INPUT", "Tool input must be plain JSON data");
  }

  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (BLOCKED_OBJECT_KEYS.has(key)) {
      throw routingError("INVALID_TOOL_INPUT", "Tool input contains a reserved object key");
    }
    result[key] = jsonClone(item, depth + 1);
  }
  return result;
}

function jsonObjectClone(value: unknown, code: "INVALID_TOOL_DEFINITION" | "INVALID_TOOL_INPUT"): JsonObject {
  try {
    const cloned = jsonClone(value);
    if (!isRecord(cloned)) throw new Error("root is not an object");
    return cloned;
  } catch (error) {
    if (error instanceof ChatRoutingError && error.code === code) throw error;
    throw routingError(code, `${code === "INVALID_TOOL_DEFINITION" ? "Tool schema" : "Tool input"} must be a JSON object`, error);
  }
}

function normalizeSecretValues(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 64) {
    throw routingError("INVALID_REQUEST", "At most 64 secret values may be registered for redaction");
  }
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > 16_000) {
      throw routingError("INVALID_REQUEST", "Registered secret values must be non-empty strings");
    }
    normalized.add(value);
  }
  return [...normalized].sort((left, right) => right.length - left.length);
}

function replaceExactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  return result;
}

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let result = replaceExactSecrets(text, secrets);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function containsSecret(text: string, secrets: readonly string[] = []): boolean {
  return redactSecrets(text, secrets) !== text;
}

function sanitizeText(text: unknown, label: string, secrets: readonly string[]): string {
  if (typeof text !== "string") throw routingError("INVALID_REQUEST", `${label} must be text`);
  if (text.length === 0 || text.length > MAX_MESSAGE_CHARACTERS) {
    throw routingError(
      "INVALID_REQUEST",
      `${label} must contain 1 through ${MAX_MESSAGE_CHARACTERS} characters`,
    );
  }
  return redactSecrets(text, secrets).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function assertSchemaObjectRules(schema: unknown, path: string): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => assertSchemaObjectRules(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(schema)) return;

  if (schema["type"] === "object") {
    if (schema["additionalProperties"] !== false) {
      throw routingError(
        "INVALID_TOOL_DEFINITION",
        `Object schema at ${path} must reject additional properties`,
      );
    }
    const properties = schema["properties"];
    if (properties !== undefined && !isRecord(properties)) {
      throw routingError("INVALID_TOOL_DEFINITION", `Properties at ${path} must be an object`);
    }
    for (const propertyName of Object.keys(properties ?? {})) {
      if (BLOCKED_OBJECT_KEYS.has(propertyName) || SECRET_FIELD_PATTERN.test(propertyName)) {
        throw routingError(
          "INVALID_TOOL_DEFINITION",
          `Model-visible tool schema contains forbidden field ${JSON.stringify(propertyName)}`,
        );
      }
    }
  }

  for (const [key, child] of Object.entries(schema)) {
    if (key === "$schema") continue;
    assertSchemaObjectRules(child, `${path}.${key}`);
  }
}

function compileTool(tool: ChatToolDefinition): PreparedChatTool {
  if (!isRecord(tool)) {
    throw routingError("INVALID_TOOL_DEFINITION", "Tool definition must be an object");
  }
  if (typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
    throw routingError(
      "INVALID_TOOL_DEFINITION",
      "Tool name must match ^[a-zA-Z0-9_-]{1,64}$",
    );
  }
  if (
    typeof tool.capabilityId !== "string" ||
    tool.capabilityId.length === 0 ||
    tool.capabilityId.length > 200 ||
    typeof tool.capabilityVersion !== "string" ||
    tool.capabilityVersion.length === 0 ||
    tool.capabilityVersion.length > 100
  ) {
    throw routingError("INVALID_TOOL_DEFINITION", "Capability identity or version is invalid");
  }
  if (
    typeof tool.description !== "string" ||
    tool.description.trim().length < 12 ||
    tool.description.length > 5_000
  ) {
    throw routingError(
      "INVALID_TOOL_DEFINITION",
      "Tool description must contain 12 through 5,000 characters",
    );
  }
  if (!(tool.inputSchema instanceof z.ZodType)) {
    throw routingError("INVALID_TOOL_DEFINITION", "Tool inputSchema must be a Zod schema");
  }

  let generated: unknown;
  try {
    generated = z.toJSONSchema(tool.inputSchema);
  } catch (error) {
    throw routingError(
      "INVALID_TOOL_DEFINITION",
      `Tool ${JSON.stringify(tool.name)} cannot be represented as JSON Schema`,
      error,
    );
  }
  const jsonSchema = jsonObjectClone(generated, "INVALID_TOOL_DEFINITION");
  delete jsonSchema["$schema"];
  if (jsonSchema["type"] !== "object") {
    throw routingError("INVALID_TOOL_DEFINITION", "Tool input schema root must be an object");
  }
  assertSchemaObjectRules(jsonSchema, "$input");
  return { definition: tool, jsonSchema };
}

export function prepareChatTools(tools: readonly ChatToolDefinition[]): readonly PreparedChatTool[] {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    throw routingError("INVALID_REQUEST", `A request may expose at most ${MAX_TOOLS} tools`);
  }
  const names = new Set<string>();
  const capabilityIdentities = new Set<string>();
  return tools.map((tool) => {
    const prepared = compileTool(tool);
    if (names.has(tool.name)) {
      throw routingError("INVALID_TOOL_DEFINITION", `Duplicate tool name ${JSON.stringify(tool.name)}`);
    }
    const identity = `${tool.capabilityId}\u0000${tool.capabilityVersion}`;
    if (capabilityIdentities.has(identity)) {
      throw routingError(
        "INVALID_TOOL_DEFINITION",
        `Duplicate capability version ${JSON.stringify(tool.capabilityId)}@${JSON.stringify(tool.capabilityVersion)}`,
      );
    }
    names.add(tool.name);
    capabilityIdentities.add(identity);
    return prepared;
  });
}

function resolveLocalReference(root: JsonObject, schema: JsonObject): JsonObject {
  const reference = schema["$ref"];
  if (typeof reference !== "string") return schema;
  if (!reference.startsWith("#/")) {
    throw routingError("INVALID_TOOL_DEFINITION", "Only local JSON Schema references are supported");
  }
  let current: JsonValue = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !(segment in current)) {
      throw routingError("INVALID_TOOL_DEFINITION", "Tool schema contains an unresolved reference");
    }
    current = current[segment]!;
  }
  if (!isRecord(current)) {
    throw routingError("INVALID_TOOL_DEFINITION", "Tool schema reference must resolve to an object");
  }
  return current;
}

function typeCouldMatch(value: unknown, schema: JsonObject): boolean {
  const type = schema["type"];
  if (Array.isArray(type)) return type.some((item) => typeof item === "string" && typeCouldMatch(value, { type: item }));
  if (typeof type !== "string") return true;
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return true;
}

function assertNoUnknownKeys(value: unknown, schemaInput: JsonObject, root: JsonObject): void {
  const schema = resolveLocalReference(root, schemaInput);
  const alternatives = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(alternatives)) {
    const candidates = alternatives.filter(
      (alternative): alternative is JsonObject => isRecord(alternative) && typeCouldMatch(value, resolveLocalReference(root, alternative)),
    );
    if (candidates.length === 0) return;
    for (const candidate of candidates) {
      try {
        assertNoUnknownKeys(value, candidate, root);
        return;
      } catch (error) {
        if (!(error instanceof ChatRoutingError) || error.code !== "INVALID_TOOL_INPUT") throw error;
      }
    }
    throw routingError("INVALID_TOOL_INPUT", "Tool input contains an unknown field");
  }

  if (Array.isArray(value)) {
    const items = schema["items"];
    if (isRecord(items)) value.forEach((item) => assertNoUnknownKeys(item, items, root));
    return;
  }
  if (!isRecord(value) || schema["type"] !== "object") return;

  const properties = schema["properties"];
  if (!isRecord(properties)) {
    if (Object.keys(value).length > 0) {
      throw routingError("INVALID_TOOL_INPUT", "Tool input contains an unknown field");
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (BLOCKED_OBJECT_KEYS.has(key) || !(key in properties)) {
      throw routingError("INVALID_TOOL_INPUT", "Tool input contains an unknown field");
    }
    const propertySchema = properties[key];
    if (isRecord(propertySchema)) assertNoUnknownKeys(item, propertySchema, root);
  }
}

function assertNoSecretValues(value: unknown, secrets: readonly string[]): void {
  if (typeof value === "string") {
    if (containsSecret(value, secrets)) {
      throw routingError(
        "SECRET_INPUT_BLOCKED",
        "Authentication secrets cannot be supplied through a chat capability",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoSecretValues(item, secrets));
    return;
  }
  if (isRecord(value)) Object.values(value).forEach((item) => assertNoSecretValues(item, secrets));
}

/** Detects unknown keys stripped by permissive Zod objects, independent of JSON Schema shape. */
function assertInputKeysPreserved(input: unknown, parsed: unknown): void {
  if (Array.isArray(input)) {
    if (!Array.isArray(parsed) || input.length !== parsed.length) {
      throw routingError("INVALID_TOOL_INPUT", "Tool input changed shape during validation");
    }
    input.forEach((item, index) => assertInputKeysPreserved(item, parsed[index]));
    return;
  }
  if (!isRecord(input)) return;
  if (!isRecord(parsed)) {
    throw routingError("INVALID_TOOL_INPUT", "Tool input changed shape during validation");
  }
  for (const [key, item] of Object.entries(input)) {
    if (!(key in parsed)) {
      throw routingError("INVALID_TOOL_INPUT", "Tool input contains an unknown field");
    }
    assertInputKeysPreserved(item, parsed[key]);
  }
}

export function validateToolInput(
  tool: PreparedChatTool,
  input: unknown,
  secrets: readonly string[] = [],
): JsonObject {
  if (!isRecord(input)) {
    throw routingError("INVALID_TOOL_INPUT", "Tool input must be an object");
  }
  assertNoSecretValues(input, secrets);
  assertNoUnknownKeys(input, tool.jsonSchema, tool.jsonSchema);

  const parsed = tool.definition.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw routingError(
      "INVALID_TOOL_INPUT",
      `Tool ${JSON.stringify(tool.definition.name)} received invalid input`,
    );
  }
  assertInputKeysPreserved(input, parsed.data);
  const normalized = jsonObjectClone(parsed.data, "INVALID_TOOL_INPUT");
  assertNoSecretValues(normalized, secrets);
  return normalized;
}

export function prepareChatRouteRequest(request: ChatRouteRequest): PreparedChatRouteRequest {
  if (!isRecord(request)) throw routingError("INVALID_REQUEST", "Chat route request must be an object");
  const secrets = normalizeSecretValues(request.secrets);
  const currentMessageContainedSecret =
    typeof request.message === "string" && containsSecret(request.message, secrets);
  const message = sanitizeText(request.message, "Message", secrets);

  const rawHistory = request.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > MAX_HISTORY_MESSAGES) {
    throw routingError(
      "INVALID_REQUEST",
      `Chat history may contain at most ${MAX_HISTORY_MESSAGES} messages`,
    );
  }
  const history = rawHistory.map((item, index): ChatTextMessage => {
    if (!isRecord(item) || (item.role !== "user" && item.role !== "assistant")) {
      throw routingError("INVALID_REQUEST", `History message ${index + 1} has an invalid role`);
    }
    return {
      role: item.role,
      text: sanitizeText(item.text, `History message ${index + 1}`, secrets),
    };
  });
  const totalCharacters = message.length + history.reduce((sum, item) => sum + item.text.length, 0);
  if (totalCharacters > MAX_TOTAL_MESSAGE_CHARACTERS) {
    throw routingError("INVALID_REQUEST", "Chat context is too large");
  }

  return {
    message,
    history,
    tools: prepareChatTools(request.tools),
    secrets,
    currentMessageContainedSecret,
  };
}

export function sanitizeModelOutput(text: string, secrets: readonly string[]): string {
  return redactSecrets(text, secrets)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, 16_000);
}
