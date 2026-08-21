import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

/**
 * Provider-neutral projection of one approved catalog capability.
 *
 * Authentication material must be resolved by the run service and must never be
 * represented by this model-visible schema. A single Zod schema is intentionally
 * used for both JSON Schema generation and the independent local validation step.
 */
export interface ChatToolDefinition {
  readonly name: string;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  /**
   * Optional typed result contract used only to validate explicit prior-step
   * bindings. It is never treated as provider output and never relaxes the
   * deterministic runtime's authoritative output validation.
   */
  readonly outputSchema?: z.ZodType;
}

export interface ChatTextMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ChatRouteRequest {
  readonly message: string;
  readonly history?: readonly ChatTextMessage[];
  readonly tools: readonly ChatToolDefinition[];
  /**
   * Exact secret values that may have entered the UI accidentally. Values are
   * used only for local detection/redaction and are never included in a request.
   */
  readonly secrets?: readonly string[];
  /**
   * Request-lifecycle cancellation. This is control metadata only and must never
   * be serialized into a provider request body.
   */
  readonly signal?: AbortSignal;
}

export const ChatRouteMetadataSchema = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200).nullable(),
    responseId: z.string().min(1).max(300).nullable(),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

export const ChatReplyRouteSchema = z
  .object({
    kind: z.literal("reply"),
    text: z.string().min(1).max(16_000),
    metadata: ChatRouteMetadataSchema,
  })
  .strict();

export const ChatInvokeRouteSchema = z
  .object({
    kind: z.literal("invoke"),
    toolCallId: z.string().min(1).max(300),
    toolName: z.string().min(1).max(64),
    capabilityId: z.string().min(1).max(200),
    capabilityVersion: z.string().min(1).max(100),
    arguments: JsonObjectSchema,
    assistantText: z.string().min(1).max(16_000).nullable(),
    metadata: ChatRouteMetadataSchema,
  })
  .strict();

const ChatSequenceIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u);

const ChatSequencePathSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
  )
  .max(8);

/**
 * A downstream input may be sourced only from one collection produced by an
 * earlier successful step. Exactly one row continues automatically; zero rows
 * stop the sequence and multiple rows require a direct authenticated choice.
 */
export const ChatSequenceBindingSchema = z
  .object({
    sourceStepId: ChatSequenceIdentifierSchema,
    sourceCollectionPath: ChatSequencePathSchema.min(1),
    valuePath: ChatSequencePathSchema,
    targetInput: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
    selection: z.literal("exactly_one"),
    onZero: z.literal("stop_no_match"),
    onMany: z.literal("pause_for_authenticated_selection"),
  })
  .strict();

export const ChatSequenceStepSchema = z
  .object({
    stepId: ChatSequenceIdentifierSchema,
    toolName: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    capabilityId: z.string().min(1).max(200),
    capabilityVersion: z.string().min(1).max(100),
    literalArguments: JsonObjectSchema,
    bindings: z.array(ChatSequenceBindingSchema).max(16),
  })
  .strict();

/** Provider-neutral, model-proposed orchestration; the API binds every step. */
export const ChatSequenceRouteSchema = z
  .object({
    kind: z.literal("sequence"),
    toolCallId: z.string().min(1).max(300),
    steps: z.array(ChatSequenceStepSchema).min(1).max(3),
    failurePolicy: z.literal("stop_on_non_success"),
    assistantText: z.string().min(1).max(16_000).nullable(),
    metadata: ChatRouteMetadataSchema,
  })
  .strict();

export type ChatSequenceBinding = z.infer<typeof ChatSequenceBindingSchema>;
export type ChatSequenceStep = z.infer<typeof ChatSequenceStepSchema>;
export type ChatSequenceRoute = z.infer<typeof ChatSequenceRouteSchema>;

export const ChatRouteResultSchema = z.discriminatedUnion("kind", [
  ChatReplyRouteSchema,
  ChatInvokeRouteSchema,
  ChatSequenceRouteSchema,
]);

export type ChatRouteResult = z.infer<typeof ChatRouteResultSchema>;

export interface ChatRouter {
  readonly name: string;
  readonly model: string | null;
  /** Maximum wall-clock time this router needs before its caller should abort it. */
  readonly requestTimeoutMs: number;
  route(request: ChatRouteRequest): Promise<ChatRouteResult>;
}

export type ChatRoutingErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_TOOL_DEFINITION"
  | "INVALID_TOOL_INPUT"
  | "SECRET_INPUT_BLOCKED"
  | "TOOL_CALL_LIMIT_EXCEEDED"
  | "REQUEST_CANCELLED"
  | "PROVIDER_CONFIGURATION_ERROR"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_UNAVAILABLE";

export class ChatRoutingError extends Error {
  readonly code: ChatRoutingErrorCode;

  constructor(code: ChatRoutingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatRoutingError";
    this.code = code;
  }
}

export class ChatProviderUnavailableError extends ChatRoutingError {
  readonly provider: string;

  constructor(provider: string, message: string, options?: ErrorOptions) {
    super("PROVIDER_UNAVAILABLE", message, options);
    this.name = "ChatProviderUnavailableError";
    this.provider = provider;
  }
}

export class ChatRequestCancelledError extends ChatRoutingError {
  constructor() {
    // Do not retain AbortSignal.reason: upstream cancellation reasons can carry
    // implementation details that do not belong in logs or API responses.
    super("REQUEST_CANCELLED", "Chat request was cancelled");
    this.name = "ChatRequestCancelledError";
  }
}

export function throwIfChatRequestCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ChatRequestCancelledError();
}

export function validateRouteResult(result: unknown): ChatRouteResult {
  return ChatRouteResultSchema.parse(result);
}
