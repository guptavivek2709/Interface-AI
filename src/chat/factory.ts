import { AnthropicChatRouter, type AnthropicChatRouterOptions } from "./anthropicRouter.js";
import type { ChatRouter } from "./contracts.js";
import { DeterministicChatRouter } from "./deterministicRouter.js";
import { ResilientChatRouter } from "./resilientRouter.js";

export interface CreateChatRouterOptions extends AnthropicChatRouterOptions {
  /** Select deterministic mode even when ANTHROPIC_API_KEY is configured. */
  readonly offline?: boolean;
}

/**
 * Anthropic is primary unless deterministic mode is explicitly requested.
 * Missing credentials fail startup instead of silently degrading production.
 */
export function createChatRouter(options: CreateChatRouterOptions = {}): ChatRouter {
  const offline = new DeterministicChatRouter();
  if (options.offline === true) return offline;
  // Construction validates configuration and deliberately throws when no
  // credential is available; deterministic mode is never selected implicitly.
  const primary = new AnthropicChatRouter(options);
  return new ResilientChatRouter(primary, offline);
}
