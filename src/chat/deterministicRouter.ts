import {
  ChatRouteResultSchema,
  ChatRoutingError,
  throwIfChatRequestCancelled,
  type ChatRouteRequest,
  type ChatRouteResult,
  type ChatRouter,
} from "./contracts.js";
import { prepareChatRouteRequest, validateToolInput } from "./security.js";

const RUN_COMMAND = /^\/run\s+([^\s]+)(?:\s+([\s\S]+))?$/u;

function offlineMetadata(startedAt: number) {
  return {
    provider: "deterministic-offline",
    model: null,
    responseId: null,
    latencyMs: Date.now() - startedAt,
    fallbackFrom: null,
  } as const;
}

export class DeterministicChatRouter implements ChatRouter {
  readonly name = "deterministic-offline";
  readonly model = null;
  readonly requestTimeoutMs = 1_000;

  async route(request: ChatRouteRequest): Promise<ChatRouteResult> {
    throwIfChatRequestCancelled(request.signal);
    const startedAt = Date.now();
    const prepared = prepareChatRouteRequest(request);
    const metadata = offlineMetadata(startedAt);

    if (prepared.currentMessageContainedSecret) {
      return ChatRouteResultSchema.parse({
        kind: "reply",
        text: "I removed authentication data from that message. Use the secure sign-in controls and try again without passwords, keys, or tokens.",
        metadata,
      });
    }

    const command = prepared.message.trim();
    if (command === "/capabilities" || command === "/help") {
      const available = prepared.tools.map((tool) => tool.definition.name).sort();
      return ChatRouteResultSchema.parse({
        kind: "reply",
        text:
          available.length === 0
            ? "No approved chat capabilities are currently available."
            : `Available capabilities: ${available.join(", ")}. Use /run <capability> <json arguments>.`,
        metadata,
      });
    }

    const match = RUN_COMMAND.exec(command);
    if (!match) {
      return ChatRouteResultSchema.parse({
        kind: "reply",
        text: "Offline routing is active. Use /capabilities, then /run <capability> <json arguments>. No capability was started.",
        metadata,
      });
    }

    const requestedName = match[1]!;
    const tool = prepared.tools.find(
      (candidate) =>
        candidate.definition.name === requestedName ||
        candidate.definition.capabilityId === requestedName,
    );
    if (!tool) {
      return ChatRouteResultSchema.parse({
        kind: "reply",
        text: `No approved capability matches ${JSON.stringify(requestedName)}. Use /capabilities to list exact names.`,
        metadata,
      });
    }

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(match[2] ?? "{}") as unknown;
    } catch {
      throw new ChatRoutingError(
        "INVALID_TOOL_INPUT",
        "Offline /run arguments must be one valid JSON object",
      );
    }
    const validatedArguments = validateToolInput(tool, rawInput, prepared.secrets);
    return ChatRouteResultSchema.parse({
      kind: "invoke",
      toolCallId: `offline-${crypto.randomUUID()}`,
      toolName: tool.definition.name,
      capabilityId: tool.definition.capabilityId,
      capabilityVersion: tool.definition.capabilityVersion,
      arguments: validatedArguments,
      assistantText: null,
      metadata,
    });
  }
}
