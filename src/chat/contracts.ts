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
    fallbackFrom: z.string().min(1).max(100).nullable(),
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

export const ChatRouteResultSchema = z.discriminatedUnion("kind", [
  ChatReplyRouteSchema,
  ChatInvokeRouteSchema,
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
