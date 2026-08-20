import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type { JsonObject, JsonValue } from "./contracts.js";
import { ChatRoutingError } from "./contracts.js";
import type { PreparedChatTool } from "./security.js";

/** Current explicit strict-schema limits documented by Anthropic. */
const MAX_STRICT_TOOLS = 20;
const MAX_OPTIONAL_PARAMETERS = 24;
const MAX_UNION_PARAMETERS = 16;

/** Conservative local limits for provider grammar size and traversal cost. */
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_CHARACTERS = 256_000;
const MAX_PROPERTIES_PER_OBJECT = 256;
const MAX_UNION_BRANCHES = 32;
const MAX_ENUM_VALUES = 100;
const MAX_DESCRIPTION_CHARACTERS = 8_000;

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

const SUPPORTED_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "type",
  "anyOf",
  "allOf",
  "description",
  "title",
  "properties",
  "additionalProperties",
  "required",
  "format",
  "items",
  "minItems",
  "enum",
  "const",
]);

export interface AnthropicPreparedTool {
  readonly prepared: PreparedChatTool;
  readonly inputSchema: JsonObject;
}

interface Complexity {
  nodes: number;
  optionalParameters: number;
  unionParameters: number;
}

function invalid(message: string, cause?: unknown): ChatRoutingError {
  return new ChatRoutingError(
    "INVALID_TOOL_DEFINITION",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

/**
 * Zod represents multiple string checks as `allOf` entries that omit `type` and
 * inherit it from their parent. Anthropic's official transformer expects every
 * such entry to carry a type, so make that standard JSON-Schema inheritance
 * explicit on a private clone before transformation.
 */
function materializeInheritedAllOfTypes(value: unknown, inheritedType?: JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach((item) => materializeInheritedAllOfTypes(item, inheritedType));
    return;
  }
  if (!isRecord(value)) return;

  const localType = value["type"] as JsonValue | undefined;
  const effectiveType = localType ?? inheritedType;
  const allOf = value["allOf"];
  if (Array.isArray(allOf) && effectiveType !== undefined) {
    for (const entry of allOf) {
      if (
        isRecord(entry) &&
        entry["type"] === undefined &&
        entry["$ref"] === undefined &&
        entry["anyOf"] === undefined &&
        entry["oneOf"] === undefined &&
        entry["allOf"] === undefined
      ) {
        entry["type"] = cloneJson(effectiveType);
      }
    }
  }

  for (const child of Object.values(value)) {
    materializeInheritedAllOfTypes(child, effectiveType);
  }
}

function jsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

/** The official transformer deliberately lowers value constraints to prose. */
function restoreProviderSupportedValueConstraints(source: unknown, target: unknown): void {
  if (!isRecord(source) || !isRecord(target)) return;

  if (Array.isArray(source["enum"])) {
    const values = source["enum"];
    if (values.length === 0 || values.length > MAX_ENUM_VALUES || !values.every(jsonScalar)) {
      throw invalid("Anthropic tool enum is empty, too large, or contains a non-JSON scalar");
    }
    target["enum"] = cloneJson(values as JsonValue[]);
  }
  if (source["const"] !== undefined) {
    if (!jsonScalar(source["const"])) {
      throw invalid("Anthropic tool const must be a finite JSON scalar");
    }
    target["const"] = source["const"];
  }

  const sourceProperties = source["properties"];
  const targetProperties = target["properties"];
  if (isRecord(sourceProperties) && isRecord(targetProperties)) {
    for (const [name, sourceProperty] of Object.entries(sourceProperties)) {
      restoreProviderSupportedValueConstraints(sourceProperty, targetProperties[name]);
    }
  }
  const sourceDefinitions = source["$defs"];
  const targetDefinitions = target["$defs"];
  if (isRecord(sourceDefinitions) && isRecord(targetDefinitions)) {
    for (const [name, sourceDefinition] of Object.entries(sourceDefinitions)) {
      restoreProviderSupportedValueConstraints(sourceDefinition, targetDefinitions[name]);
    }
  }
  restoreProviderSupportedValueConstraints(source["items"], target["items"]);

  const sourceAnyOf = Array.isArray(source["anyOf"])
    ? source["anyOf"]
    : Array.isArray(source["oneOf"])
      ? source["oneOf"]
      : undefined;
  const targetAnyOf = target["anyOf"];
  if (sourceAnyOf && Array.isArray(targetAnyOf)) {
    sourceAnyOf.forEach((item, index) => restoreProviderSupportedValueConstraints(item, targetAnyOf[index]));
  }
  if (Array.isArray(source["allOf"]) && Array.isArray(target["allOf"])) {
    source["allOf"].forEach((item, index) =>
      restoreProviderSupportedValueConstraints(item, (target["allOf"] as unknown[])[index]));
  }
}

function resolveLocalReference(root: JsonObject, reference: string): unknown {
  if (!reference.startsWith("#/")) throw invalid("Anthropic tool schema may use only local JSON references");
  let current: unknown = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !(segment in current)) {
      throw invalid("Anthropic tool schema contains an unresolved local reference");
    }
    current = current[segment];
  }
  return current;
}

function assertType(value: unknown): void {
  const types = Array.isArray(value) ? value : [value];
  if (types.length === 0 || !types.every((item) => typeof item === "string" && SUPPORTED_TYPES.has(item))) {
    throw invalid("Anthropic tool schema contains an unsupported JSON type");
  }
  if (new Set(types).size !== types.length) {
    throw invalid("Anthropic tool schema type arrays cannot contain duplicates");
  }
  // The official transformer cannot safely preserve the structure of object or
  // array unions expressed as a type array. Use anyOf branches instead.
  if (types.length > 1 && (types.includes("object") || types.includes("array"))) {
    throw invalid("Anthropic object and array unions must use explicit anyOf branches");
  }
}

function preflightNode(
  node: unknown,
  root: JsonObject,
  complexity: Complexity,
  depth: number,
  parameterNode: boolean,
): void {
  complexity.nodes += 1;
  if (complexity.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
    throw invalid("Anthropic tool schemas exceed the local grammar complexity limit");
  }
  if (!isRecord(node)) throw invalid("Anthropic tool schema nodes must be objects");

  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw invalid(`Anthropic tool schema contains unsupported keyword ${JSON.stringify(keyword)}`);
    }
  }

  const reference = node["$ref"];
  if (reference !== undefined) {
    if (typeof reference !== "string") throw invalid("Anthropic tool schema reference must be text");
    const referenced = resolveLocalReference(root, reference);
    if (!isRecord(referenced)) {
      throw invalid("Anthropic tool schema reference must resolve to a schema object");
    }
    if (Object.keys(node).length !== 1) {
      throw invalid("Anthropic tool schema reference nodes cannot contain sibling keywords");
    }
    if (parameterNode && (Array.isArray(referenced["anyOf"]) || Array.isArray(referenced["type"]))) {
      complexity.unionParameters += 1;
    }
    return;
  }

  if (node["type"] !== undefined) assertType(node["type"]);
  if (parameterNode && (Array.isArray(node["anyOf"]) || Array.isArray(node["type"]))) {
    complexity.unionParameters += 1;
  }

  if (node["description"] !== undefined &&
      (typeof node["description"] !== "string" || node["description"].length > MAX_DESCRIPTION_CHARACTERS)) {
    throw invalid("Anthropic tool schema description is invalid or too long");
  }
  if (node["title"] !== undefined && typeof node["title"] !== "string") {
    throw invalid("Anthropic tool schema title must be text");
  }
  if (node["format"] !== undefined &&
      (typeof node["format"] !== "string" || !SUPPORTED_FORMATS.has(node["format"]))) {
    throw invalid("Anthropic tool schema contains an unsupported string format");
  }
  if (node["minItems"] !== undefined && node["minItems"] !== 0 && node["minItems"] !== 1) {
    throw invalid("Anthropic strict schemas support minItems only at zero or one");
  }

  if (node["enum"] !== undefined) {
    if (!Array.isArray(node["enum"]) || node["enum"].length === 0 ||
        node["enum"].length > MAX_ENUM_VALUES || !node["enum"].every(jsonScalar)) {
      throw invalid("Anthropic tool schema enum is invalid");
    }
  }
  if (node["const"] !== undefined && !jsonScalar(node["const"])) {
    throw invalid("Anthropic tool schema const is invalid");
  }

  const properties = node["properties"];
  if (properties !== undefined) {
    if (!isRecord(properties) || Object.keys(properties).length > MAX_PROPERTIES_PER_OBJECT) {
      throw invalid("Anthropic tool object has invalid or excessive properties");
    }
    if (node["additionalProperties"] !== false) {
      throw invalid("Anthropic tool objects must reject additional properties");
    }
    const required = node["required"];
    if (required !== undefined &&
        (!Array.isArray(required) || !required.every((item) => typeof item === "string" && item in properties))) {
      throw invalid("Anthropic tool required fields must reference declared properties");
    }
    const requiredNames = new Set(Array.isArray(required) ? required as string[] : []);
    if (Array.isArray(required) && requiredNames.size !== required.length) {
      throw invalid("Anthropic tool required fields cannot contain duplicates");
    }
    for (const [name, property] of Object.entries(properties)) {
      if (!requiredNames.has(name)) complexity.optionalParameters += 1;
      preflightNode(property, root, complexity, depth + 1, true);
    }
  }

  const definitions = node["$defs"];
  if (definitions !== undefined) {
    if (!isRecord(definitions)) throw invalid("Anthropic tool schema definitions must be an object");
    for (const definition of Object.values(definitions)) {
      preflightNode(definition, root, complexity, depth + 1, false);
    }
  }
  if (node["items"] !== undefined) preflightNode(node["items"], root, complexity, depth + 1, false);
  for (const unionKeyword of ["anyOf", "allOf"] as const) {
    const alternatives = node[unionKeyword];
    if (alternatives !== undefined) {
      if (!Array.isArray(alternatives) || alternatives.length === 0 ||
          alternatives.length > MAX_UNION_BRANCHES) {
        throw invalid(`Anthropic tool schema ${unionKeyword} must be a non-empty array`);
      }
      for (const alternative of alternatives) {
        preflightNode(alternative, root, complexity, depth + 1, false);
      }
    }
  }
}

function transformCanonicalSchema(canonical: JsonObject): JsonObject {
  let normalized: JsonObject;
  let transformed: unknown;
  try {
    normalized = cloneJson(canonical);
    materializeInheritedAllOfTypes(normalized);
    transformed = transformJSONSchema(normalized as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ChatRoutingError) throw error;
    throw invalid("Tool schema cannot be transformed to Anthropic's strict JSON-Schema subset", error);
  }
  if (!isRecord(transformed)) throw invalid("Anthropic schema transformer returned a non-object schema");
  restoreProviderSupportedValueConstraints(normalized, transformed);
  return transformed as JsonObject;
}

export function compileAnthropicToolSchema(canonical: JsonObject): JsonObject {
  let canonicalSize: number;
  try {
    canonicalSize = JSON.stringify(canonical).length;
  } catch (error) {
    throw invalid("Anthropic tool schema must be finite JSON data", error);
  }
  if (canonicalSize > MAX_SCHEMA_CHARACTERS) {
    throw invalid("Anthropic tool schema exceeds the local serialized-size limit");
  }
  const transformed = transformCanonicalSchema(canonical);
  if (transformed["type"] !== "object") {
    throw invalid("Anthropic tool input schema root must be an object");
  }
  if (JSON.stringify(transformed).length > MAX_SCHEMA_CHARACTERS) {
    throw invalid("Anthropic tool schema exceeds the local serialized-size limit");
  }
  const complexity: Complexity = { nodes: 0, optionalParameters: 0, unionParameters: 0 };
  preflightNode(transformed, transformed, complexity, 0, false);
  if (complexity.optionalParameters > MAX_OPTIONAL_PARAMETERS) {
    throw invalid(`Anthropic strict tools expose more than ${MAX_OPTIONAL_PARAMETERS} optional parameters`);
  }
  if (complexity.unionParameters > MAX_UNION_PARAMETERS) {
    throw invalid(`Anthropic strict tools expose more than ${MAX_UNION_PARAMETERS} union parameters`);
  }
  return transformed;
}

export function compileAnthropicTools(tools: readonly PreparedChatTool[]): readonly AnthropicPreparedTool[] {
  if (tools.length > MAX_STRICT_TOOLS) {
    throw invalid(`Anthropic strict tool use supports at most ${MAX_STRICT_TOOLS} tools per request`);
  }
  const compiled = tools.map((prepared) => ({
    prepared,
    inputSchema: compileAnthropicToolSchema(prepared.jsonSchema),
  }));

  // Anthropic applies optional/union limits across the complete tool set, not
  // independently per tool. Recount the already transformed schemas together.
  const combined: Complexity = { nodes: 0, optionalParameters: 0, unionParameters: 0 };
  for (const tool of compiled) preflightNode(tool.inputSchema, tool.inputSchema, combined, 0, false);
  if (combined.optionalParameters > MAX_OPTIONAL_PARAMETERS) {
    throw invalid(`Anthropic strict tools expose more than ${MAX_OPTIONAL_PARAMETERS} optional parameters`);
  }
  if (combined.unionParameters > MAX_UNION_PARAMETERS) {
    throw invalid(`Anthropic strict tools expose more than ${MAX_UNION_PARAMETERS} union parameters`);
  }
  return compiled;
}
