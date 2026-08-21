import { AnthropicChatRouter, type AnthropicChatRouterOptions } from "./anthropicRouter.js";
import type { ChatRouter } from "./contracts.js";

export type CreateChatRouterOptions = AnthropicChatRouterOptions;

/**
 * Anthropic is the sole production intent provider. Missing credentials and
 * provider outages fail explicitly; production never changes execution
 * semantics by falling back to a rules engine or another model.
 */
export function createChatRouter(options: CreateChatRouterOptions = {}): ChatRouter {
  return new AnthropicChatRouter(options);
}
