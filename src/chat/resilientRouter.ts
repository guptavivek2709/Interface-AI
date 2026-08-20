import {
  ChatProviderUnavailableError,
  ChatRouteResultSchema,
  throwIfChatRequestCancelled,
  type ChatRouteRequest,
  type ChatRouteResult,
  type ChatRouter,
} from "./contracts.js";

/** Falls back only for an explicitly classified provider outage, never for unsafe or invalid model output. */
export class ResilientChatRouter implements ChatRouter {
  readonly name: string;
  readonly model: string | null;
  readonly requestTimeoutMs: number;
  readonly #primary: ChatRouter;
  readonly #fallback: ChatRouter;

  constructor(primary: ChatRouter, fallback: ChatRouter) {
    this.#primary = primary;
    this.#fallback = fallback;
    this.name = `${primary.name}-with-${fallback.name}-fallback`;
    this.model = primary.model;
    this.requestTimeoutMs = primary.requestTimeoutMs + fallback.requestTimeoutMs;
  }

  async route(request: ChatRouteRequest): Promise<ChatRouteResult> {
    try {
      return await this.#primary.route(request);
    } catch (error) {
      if (!(error instanceof ChatProviderUnavailableError)) throw error;
      throwIfChatRequestCancelled(request.signal);
      const fallbackResult = await this.#fallback.route(request);
      return ChatRouteResultSchema.parse({
        ...fallbackResult,
        metadata: {
          ...fallbackResult.metadata,
          fallbackFrom: this.#primary.name,
        },
      });
    }
  }
}
