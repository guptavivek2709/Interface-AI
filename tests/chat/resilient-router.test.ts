import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ChatProviderUnavailableError,
  ChatRoutingError,
  type ChatRouteRequest,
  type ChatRouteResult,
  type ChatRouter,
  type ChatToolDefinition,
} from "../../src/chat/contracts.js";
import { createChatRouter } from "../../src/chat/factory.js";
import { ResilientChatRouter } from "../../src/chat/resilientRouter.js";

const TOOL: ChatToolDefinition = {
  name: "member_lookup",
  capabilityId: "member.lookup_by_number",
  capabilityVersion: "2.0.0",
  description: "Find exactly one member using an exact, user-supplied member number.",
  inputSchema: z.strictObject({ memberId: z.string() }),
};

const REQUEST: ChatRouteRequest = { message: "/capabilities", tools: [TOOL] };

function router(
  name: string,
  implementation: (request: ChatRouteRequest) => Promise<ChatRouteResult>,
): ChatRouter {
  return { name, model: null, requestTimeoutMs: 1_000, route: implementation };
}

describe("ResilientChatRouter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back only for a classified provider outage", async () => {
    const primary = router("primary", async () => {
      throw new ChatProviderUnavailableError("primary", "temporarily unavailable");
    });
    const fallbackRoute = vi.fn(async (): Promise<ChatRouteResult> => ({
      kind: "reply",
      text: "Offline help",
      metadata: {
        provider: "offline",
        model: null,
        responseId: null,
        latencyMs: 0,
        fallbackFrom: null,
      },
    }));

    const result = await new ResilientChatRouter(primary, router("offline", fallbackRoute)).route(
      REQUEST,
    );
    expect(result).toMatchObject({
      kind: "reply",
      metadata: { provider: "offline", fallbackFrom: "primary" },
    });
    expect(fallbackRoute).toHaveBeenCalledOnce();
  });

  it("does not hide validation or unsafe-provider-response failures behind fallback", async () => {
    const primary = router("primary", async () => {
      throw new ChatRoutingError("PROVIDER_RESPONSE_INVALID", "invalid response");
    });
    const fallbackRoute = vi.fn();
    await expect(
      new ResilientChatRouter(primary, router("offline", fallbackRoute)).route(REQUEST),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(fallbackRoute).not.toHaveBeenCalled();
  });

  it.each([
    "INVALID_REQUEST",
    "INVALID_TOOL_DEFINITION",
    "INVALID_TOOL_INPUT",
    "SECRET_INPUT_BLOCKED",
    "TOOL_CALL_LIMIT_EXCEEDED",
    "REQUEST_CANCELLED",
    "PROVIDER_CONFIGURATION_ERROR",
    "PROVIDER_REQUEST_FAILED",
    "PROVIDER_RESPONSE_INVALID",
  ] as const)("does not fall back for classified %s failures", async (code) => {
    const primary = router("primary", async () => {
      throw new ChatRoutingError(code, "classified failure");
    });
    const fallbackRoute = vi.fn();

    await expect(
      new ResilientChatRouter(primary, router("offline", fallbackRoute)).route(REQUEST),
    ).rejects.toMatchObject({ code });
    expect(fallbackRoute).not.toHaveBeenCalled();
  });

  it("honors caller cancellation that races with a classified outage", async () => {
    const controller = new AbortController();
    const primary = router("primary", async () => {
      controller.abort(new Error("private disconnect detail"));
      throw new ChatProviderUnavailableError("primary", "temporarily unavailable");
    });
    const fallbackRoute = vi.fn();

    await expect(
      new ResilientChatRouter(primary, router("offline", fallbackRoute)).route({
        ...REQUEST,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(fallbackRoute).not.toHaveBeenCalled();
  });

  it("selects deterministic mode when offline is explicit", () => {
    expect(createChatRouter({ offline: true }).name).toBe("deterministic-offline");
  });

  it("fails configuration instead of silently selecting offline mode when the key is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => createChatRouter({ offline: false, apiKey: "" })).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CONFIGURATION_ERROR" }),
    );
  });
});
