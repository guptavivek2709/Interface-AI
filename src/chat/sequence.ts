import { z } from "zod";
import {
  ChatRouteMetadataSchema,
  ChatRoutingError,
  ChatSequenceBindingSchema,
  ChatSequenceRouteSchema,
  ChatSequenceStepSchema,
  type ChatSequenceRoute,
  type ChatSequenceStep,
  type JsonObject,
  type JsonValue,
} from "./contracts.js";
import { validatePartialToolInput, type PreparedChatTool } from "./security.js";

export const CHAT_SEQUENCE_TOOL_NAME = "propose_capability_sequence";
const MAX_LITERAL_ARGUMENTS_JSON_CHARACTERS = 16_000;

const DraftSequenceStepSchema = z
  .object({
    stepId: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
    toolName: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    literalArguments: z.record(z.string(), z.unknown()),
    bindings: z.array(ChatSequenceBindingSchema).max(16),
  })
  .strict();

export const ChatSequenceDraftSchema = z.array(DraftSequenceStepSchema).min(1).max(3);

const ProviderSequenceStepSchema = z
  .object({
    stepId: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
    toolName: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    literalArgumentsJson: z.string().min(2).max(MAX_LITERAL_ARGUMENTS_JSON_CHARACTERS),
    bindings: z.array(ChatSequenceBindingSchema).max(16),
  })
  .strict();

export const ChatSequenceProviderInputSchema = z
  .object({ steps: z.array(ProviderSequenceStepSchema).min(1).max(3) })
  .strict();

export type ChatSequenceDraftStep = z.infer<typeof DraftSequenceStepSchema>;

export interface BuildChatSequenceRouteRequest {
  readonly toolCallId: string;
  readonly draftSteps: unknown;
  readonly assistantText: string | null;
  readonly metadata: z.infer<typeof ChatRouteMetadataSchema>;
  readonly tools: readonly PreparedChatTool[];
  readonly secrets?: readonly string[];
}

export interface SequenceProposalToolDefinition {
  readonly name: typeof CHAT_SEQUENCE_TOOL_NAME;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

function invalid(code: "INVALID_TOOL_INPUT" | "PROVIDER_RESPONSE_INVALID", message: string): never {
  throw new ChatRoutingError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function schemaPropertyNames(schema: JsonObject | undefined): readonly string[] {
  const properties = schema?.["properties"];
  return isRecord(properties) ? Object.keys(properties).sort() : [];
}

/**
 * Strict provider-side meta-tool. Literal arguments are encoded as JSON text so
 * the provider schema cannot silently accept arbitrary fields; they are parsed
 * and independently validated against the selected capability below.
 */
export function compileSequenceProposalTool(
  tools: readonly PreparedChatTool[],
): SequenceProposalToolDefinition {
  const names = tools.map((tool) => tool.definition.name);
  if (names.length === 0) {
    return invalid("INVALID_TOOL_INPUT", "A sequence proposal requires at least one approved tool");
  }
  const outputSummary = tools
    .map((tool) => `${tool.definition.name} outputs [${schemaPropertyNames(tool.outputJsonSchema).join(", ") || "none"}]`)
    .join("; ")
    .slice(0, 3_500);
  const pathSchema: JsonObject = {
    type: "array",
    items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$", minLength: 1, maxLength: 100 },
    maxItems: 8,
  };
  const bindingSchema: JsonObject = {
    type: "object",
    additionalProperties: false,
    properties: {
      sourceStepId: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]*$", minLength: 1, maxLength: 64 },
      sourceCollectionPath: { ...pathSchema, minItems: 1 },
      valuePath: pathSchema,
      targetInput: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$", minLength: 1, maxLength: 100 },
      selection: { type: "string", enum: ["exactly_one"] },
      onZero: { type: "string", enum: ["stop_no_match"] },
      onMany: { type: "string", enum: ["pause_for_authenticated_selection"] },
    },
    required: ["sourceStepId", "sourceCollectionPath", "valuePath", "targetInput", "selection", "onZero", "onMany"],
  };
  return {
    name: CHAT_SEQUENCE_TOOL_NAME,
    description: [
      "Propose one ordered sequence of one through three approved capabilities.",
      "Use literalArgumentsJson for a strict JSON object containing only values known from the user request.",
      "A later required input may be omitted only when a binding extracts it from exactly one row of an earlier typed collection; zero rows stop and multiple rows pause for an authenticated operator selection.",
      "Never supply artifact digests, idempotency keys, credentials, approval data, or parallel branches.",
      outputSummary,
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              stepId: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]*$", minLength: 1, maxLength: 64 },
              toolName: { type: "string", enum: names },
              literalArgumentsJson: { type: "string", minLength: 2, maxLength: MAX_LITERAL_ARGUMENTS_JSON_CHARACTERS },
              bindings: { type: "array", items: bindingSchema, maxItems: 16 },
            },
            required: ["stepId", "toolName", "literalArgumentsJson", "bindings"],
          },
        },
      },
      required: ["steps"],
    },
  };
}

export function parseSequenceProviderInput(input: unknown): readonly ChatSequenceDraftStep[] {
  const parsed = ChatSequenceProviderInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalid("PROVIDER_RESPONSE_INVALID", "The assistant returned invalid sequence tool input");
  }
  return parsed.data.steps.map((step) => {
    let literalArguments: unknown;
    try {
      literalArguments = JSON.parse(step.literalArgumentsJson) as unknown;
    } catch {
      return invalid("INVALID_TOOL_INPUT", "A sequence step contained malformed literal argument JSON");
    }
    if (!isRecord(literalArguments)) {
      return invalid("INVALID_TOOL_INPUT", "Sequence literal argument JSON must encode one object");
    }
    return {
      stepId: step.stepId,
      toolName: step.toolName,
      literalArguments,
      bindings: step.bindings,
    };
  });
}

function resolveReference(root: JsonObject, input: JsonObject): JsonObject {
  const reference = input["$ref"];
  if (typeof reference !== "string") return input;
  if (!reference.startsWith("#/")) {
    return invalid("INVALID_TOOL_INPUT", "A sequence binding referenced an unsupported result schema");
  }
  let current: JsonValue = root;
  for (const encoded of reference.slice(2).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !(segment in current)) {
      return invalid("INVALID_TOOL_INPUT", "A sequence binding referenced an unknown result path");
    }
    current = current[segment]!;
  }
  if (!isRecord(current)) {
    return invalid("INVALID_TOOL_INPUT", "A sequence binding referenced an invalid result schema");
  }
  return current as JsonObject;
}

function propertyAtPath(root: JsonObject, start: JsonObject, path: readonly string[]): JsonObject {
  let current = resolveReference(root, start);
  for (const segment of path) {
    const properties = current["properties"];
    if (current["type"] !== "object" || !isRecord(properties) || !isRecord(properties[segment])) {
      return invalid("INVALID_TOOL_INPUT", "A sequence binding referenced an unknown typed result path");
    }
    current = resolveReference(root, properties[segment] as JsonObject);
  }
  return current;
}

function schemaTypes(root: JsonObject, schemaInput: JsonObject): ReadonlySet<string> {
  const schema = resolveReference(root, schemaInput);
  const direct = schema["type"];
  if (typeof direct === "string") return new Set([direct]);
  if (Array.isArray(direct)) {
    return new Set(direct.filter((item): item is string => typeof item === "string"));
  }
  const alternatives = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(alternatives)) {
    const result = new Set<string>();
    for (const alternative of alternatives) {
      if (!isRecord(alternative)) continue;
      for (const type of schemaTypes(root, alternative as JsonObject)) result.add(type);
    }
    return result;
  }
  return new Set();
}

function compatibleSchemas(
  sourceRoot: JsonObject,
  sourceInput: JsonObject,
  targetRoot: JsonObject,
  targetInput: JsonObject,
): boolean {
  const source = resolveReference(sourceRoot, sourceInput);
  const target = resolveReference(targetRoot, targetInput);
  const sourceTypes = schemaTypes(sourceRoot, source);
  const targetTypes = schemaTypes(targetRoot, target);
  if (sourceTypes.size === 0 || targetTypes.size === 0) return false;
  const typeCompatible = [...sourceTypes].every((type) =>
    targetTypes.has(type) || (type === "integer" && targetTypes.has("number")),
  );
  if (!typeCompatible) return false;
  const targetFormat = target["format"];
  return typeof targetFormat !== "string" || source["format"] === targetFormat;
}

function validateBinding(
  binding: z.infer<typeof ChatSequenceBindingSchema>,
  sourceTool: PreparedChatTool,
  targetTool: PreparedChatTool,
): void {
  const outputRoot = sourceTool.outputJsonSchema;
  if (!outputRoot) {
    return invalid("INVALID_TOOL_INPUT", "A sequence binding requires a typed source output contract");
  }
  const collection = propertyAtPath(outputRoot, outputRoot, binding.sourceCollectionPath);
  if (collection["type"] !== "array" || !isRecord(collection["items"])) {
    return invalid("INVALID_TOOL_INPUT", "A sequence binding source must be a typed collection");
  }
  const item = resolveReference(outputRoot, collection["items"] as JsonObject);
  const value = binding.valuePath.length === 0
    ? item
    : propertyAtPath(outputRoot, item, binding.valuePath);
  const inputProperties = targetTool.jsonSchema["properties"];
  if (!isRecord(inputProperties) || !isRecord(inputProperties[binding.targetInput])) {
    return invalid("INVALID_TOOL_INPUT", "A sequence binding targets an unknown input");
  }
  if (!compatibleSchemas(
    outputRoot,
    value,
    targetTool.jsonSchema,
    inputProperties[binding.targetInput] as JsonObject,
  )) {
    return invalid("INVALID_TOOL_INPUT", "A sequence binding connects incompatible result and input types");
  }
}

export function validateChatSequenceSteps(
  tools: readonly PreparedChatTool[],
  draftSteps: unknown,
  secrets: readonly string[] = [],
): readonly ChatSequenceStep[] {
  const parsed = ChatSequenceDraftSchema.safeParse(draftSteps);
  if (!parsed.success) {
    return invalid("PROVIDER_RESPONSE_INVALID", "The assistant returned an invalid sequence structure");
  }
  const toolByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const priorSteps = new Map<string, { readonly tool: PreparedChatTool; readonly index: number }>();
  const steps: ChatSequenceStep[] = [];

  for (const [index, draft] of parsed.data.entries()) {
    if (priorSteps.has(draft.stepId)) {
      return invalid("PROVIDER_RESPONSE_INVALID", "The assistant returned duplicate sequence step IDs");
    }
    const tool = toolByName.get(draft.toolName);
    if (!tool) {
      return invalid("PROVIDER_RESPONSE_INVALID", "The assistant selected a sequence tool outside the approved catalog");
    }
    const targets = new Set<string>();
    for (const binding of draft.bindings) {
      if (targets.has(binding.targetInput)) {
        return invalid("INVALID_TOOL_INPUT", "A sequence step binds the same input more than once");
      }
      targets.add(binding.targetInput);
      const source = priorSteps.get(binding.sourceStepId);
      if (!source || source.index >= index) {
        return invalid("PROVIDER_RESPONSE_INVALID", "A sequence binding must reference an earlier step");
      }
      validateBinding(binding, source.tool, tool);
    }
    const literalArguments = validatePartialToolInput(tool, draft.literalArguments, [...targets], secrets);
    const step = ChatSequenceStepSchema.parse({
      stepId: draft.stepId,
      toolName: tool.definition.name,
      capabilityId: tool.definition.capabilityId,
      capabilityVersion: tool.definition.capabilityVersion,
      literalArguments,
      bindings: draft.bindings,
    });
    steps.push(step);
    priorSteps.set(step.stepId, { tool, index });
  }
  return steps;
}

export function buildChatSequenceRoute(request: BuildChatSequenceRouteRequest): ChatSequenceRoute {
  const steps = validateChatSequenceSteps(request.tools, request.draftSteps, request.secrets);
  return ChatSequenceRouteSchema.parse({
    kind: "sequence",
    toolCallId: request.toolCallId,
    steps,
    failurePolicy: "stop_on_non_success",
    assistantText: request.assistantText,
    metadata: request.metadata,
  });
}
