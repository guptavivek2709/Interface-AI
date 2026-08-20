import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AnthropicChatRouter,
  type AnthropicChatRouterOptions,
} from "../../src/chat/anthropicRouter.js";
import {
  ChatRouteResultSchema,
  ChatRoutingError,
  type ChatRouteRequest,
  type ChatToolDefinition,
} from "../../src/chat/contracts.js";

type TestClient = NonNullable<AnthropicChatRouterOptions["client"]>;

const BALANCE_TOOL: ChatToolDefinition = {
  name: "member_get_balance",
  capabilityId: "member.get_record_balance",
  capabilityVersion: "2.0.0",
  description:
    "Read a member record by exact member identifier and return structured share balances. Use only when the user requests balance information.",
  inputSchema: z.strictObject({ memberId: z.string().regex(/^\d{6}$/u) }),
};

function request(overrides: Partial<ChatRouteRequest> = {}): ChatRouteRequest {
  return {
    message: "Show the balance for member 100234",
    tools: [BALANCE_TOOL],
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_chat_123",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "I can help with that." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: "standard",
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
    },
    ...overrides,
  };
}

function fakeClient(response: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue(response);
  return {
    create,
    client: { messages: { create } } as unknown as TestClient,
  };
}

function fakeUnknownClient(response: unknown) {
  const create = vi.fn((_body: unknown, _options: unknown) => Promise.resolve(response));
  return { create, client: clientFromCreate(create) };
}

function clientFromCreate(create: ReturnType<typeof vi.fn>): TestClient {
  return { messages: { create } } as unknown as TestClient;
}

function containsSchemaKey(value: unknown, searchedKey: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSchemaKey(item, searchedKey));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => key === searchedKey || containsSchemaKey(child, searchedKey),
  );
}

async function expectRoutingCode(
  promise: Promise<unknown>,
  code: ChatRoutingError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRoutingError);
    expect((error as ChatRoutingError).code).toBe(code);
  }
}

describe("AnthropicChatRouter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("offers strict, non-parallel tools and returns a locally validated route", async () => {
    const fake = fakeClient(
      message({
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "I'll start a balance lookup." },
          {
            type: "tool_use",
            id: "toolu_balance_1",
            name: "member_get_balance",
            input: { memberId: "100234" },
            caller: { type: "direct" },
          },
        ],
      }),
    );
    const router = new AnthropicChatRouter({ client: fake.client, model: "claude-sonnet-5" });

    const result = await router.route(request());
    expect(ChatRouteResultSchema.parse(result)).toEqual(
      expect.objectContaining({
        kind: "invoke",
        toolCallId: "toolu_balance_1",
        capabilityId: "member.get_record_balance",
        capabilityVersion: "2.0.0",
        arguments: { memberId: "100234" },
        assistantText: "I'll start a balance lookup.",
      }),
    );

    const body = fake.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(body["output_config"]).toEqual({ effort: "low" });
    expect(body["tools"]).toEqual([
      expect.objectContaining({
        name: "member_get_balance",
        strict: true,
        input_schema: expect.objectContaining({
          type: "object",
          additionalProperties: false,
        }),
      }),
    ]);
    expect(body["system"]).toEqual(expect.stringContaining("Never approve or confirm"));
  });

  it("sends only the transformed provider schema and explicit SDK lifecycle options", async () => {
    const fake = fakeClient(message());
    const emailTool: ChatToolDefinition = {
      ...BALANCE_TOOL,
      name: "member_update_email",
      capabilityId: "member.update_email",
      description: "Validate and prepare an exact member email address for an approved update.",
      inputSchema: z.strictObject({ email: z.string().email() }),
    };
    const router = new AnthropicChatRouter({
      client: fake.client,
      timeoutMs: 1_234,
    });

    await router.route(request({ tools: [emailTool] }));

    const body = fake.create.mock.calls[0]![0] as Record<string, unknown>;
    const options = fake.create.mock.calls[0]![1] as Record<string, unknown>;
    expect(containsSchemaKey(body["tools"], "pattern")).toBe(false);
    expect(options).toMatchObject({ timeout: 1_234, maxRetries: 0 });
    expect(options["signal"]).toBeInstanceOf(AbortSignal);
  });

  it("returns a concise provider reply when no tool is selected", async () => {
    const fake = fakeClient(message({ content: [{ type: "text", text: "Which member ID should I use?" }] }));
    const result = await new AnthropicChatRouter({ client: fake.client }).route(
      request({ message: "Show a balance" }),
    );
    expect(result).toMatchObject({ kind: "reply", text: "Which member ID should I use?" });
  });

  it("never sends a current message containing authentication material", async () => {
    const fake = fakeClient(message());
    const result = await new AnthropicChatRouter({ client: fake.client }).route(
      request({ message: "password=hunter2; show my balance", secrets: ["hunter2"] }),
    );

    expect(result).toMatchObject({ kind: "reply" });
    expect(result.kind === "reply" ? result.text : "").toContain("secure sign-in controls");
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("redacts secrets from prior context and from provider text", async () => {
    const fake = fakeClient(
      message({ content: [{ type: "text", text: "Never echo known-secret or Bearer abc.def.ghi" }] }),
    );
    const result = await new AnthropicChatRouter({ client: fake.client }).route(
      request({
        history: [{ role: "user", text: "Earlier password=known-secret" }],
        secrets: ["known-secret"],
      }),
    );

    const serializedRequest = JSON.stringify(fake.create.mock.calls[0]![0]);
    expect(serializedRequest).not.toContain("known-secret");
    expect(JSON.stringify(result)).not.toContain("known-secret");
    expect(JSON.stringify(result)).not.toContain("abc.def.ghi");
  });

  it("rejects unknown or invalid model arguments locally without echoing their values", async () => {
    const fake = fakeClient(
      message({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_bad",
            name: "member_get_balance",
            input: { memberId: "not-valid", password: "do-not-echo" },
            caller: { type: "direct" },
          },
        ],
      }),
    );

    try {
      await new AnthropicChatRouter({ client: fake.client }).route(request());
      throw new Error("Expected route to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatRoutingError);
      expect((error as ChatRoutingError).code).toBe("INVALID_TOOL_INPUT");
      expect((error as Error).message).not.toContain("do-not-echo");
      expect((error as Error).message).not.toContain("not-valid");
    }
  });

  it("enforces a local tool-call cap even if the provider violates non-parallel choice", async () => {
    const fake = fakeClient(
      message({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "member_get_balance",
            input: { memberId: "100234" },
            caller: { type: "direct" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "member_get_balance",
            input: { memberId: "100234" },
            caller: { type: "direct" },
          },
        ],
      }),
    );
    await expectRoutingCode(
      new AnthropicChatRouter({ client: fake.client }).route(request()),
      "TOOL_CALL_LIMIT_EXCEEDED",
    );
  });

  it.each(["max_tokens", "pause_turn", "stop_sequence", "model_context_window_exceeded"])(
    "fails closed on incomplete stop reason %s",
    async (stopReason) => {
      const fake = fakeClient(message({ stop_reason: stopReason }));
      await expectRoutingCode(
        new AnthropicChatRouter({ client: fake.client }).route(request()),
        "PROVIDER_RESPONSE_INVALID",
      );
    },
  );

  it.each([
    ["a non-object envelope", null],
    ["non-array content", { id: "msg_invalid", stop_reason: "end_turn", content: "text" }],
    [
      "an unsupported content block",
      message({ content: [{ type: "thinking", thinking: "must stay private" }] }),
    ],
    ["an unsafe response identifier", message({ id: "msg_<private>" })],
  ])("fails closed on %s", async (_label, response) => {
    const fake = fakeUnknownClient(response);
    await expectRoutingCode(
      new AnthropicChatRouter({ client: fake.client }).route(request()),
      "PROVIDER_RESPONSE_INVALID",
    );
  });

  it("enforces an absolute wall-clock deadline even when an injected client ignores abort", async () => {
    vi.useFakeTimers();
    const create = vi.fn((_body: unknown, _options: unknown) =>
      new Promise<never>(() => undefined));
    const router = new AnthropicChatRouter({
      client: clientFromCreate(create),
      timeoutMs: 1_000,
    });

    const assertion = expectRoutingCode(router.route(request()), "PROVIDER_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(create).toHaveBeenCalledOnce();
    const options = create.mock.calls[0]![1] as Record<string, unknown>;
    expect((options["signal"] as AbortSignal).aborted).toBe(true);
  });

  it("propagates caller abort, does not expose its reason, and does not fall through as an outage", async () => {
    const create = vi.fn((_body: unknown, _options: unknown) =>
      new Promise<never>(() => undefined));
    const router = new AnthropicChatRouter({
      client: clientFromCreate(create),
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    const pending = router.route(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

    controller.abort(new Error("private disconnect detail"));
    try {
      await pending;
      throw new Error("Expected route to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatRoutingError);
      expect((error as ChatRoutingError).code).toBe("REQUEST_CANCELLED");
      expect((error as Error).message).not.toContain("private disconnect detail");
      expect((error as Error).cause).toBeUndefined();
    }
    const options = create.mock.calls[0]![1] as Record<string, unknown>;
    expect((options["signal"] as AbortSignal).aborted).toBe(true);
  });

  it("does not start a provider request for an already-aborted caller", async () => {
    const fake = fakeClient(message());
    const controller = new AbortController();
    controller.abort(new Error("must not cross the boundary"));

    await expectRoutingCode(
      new AnthropicChatRouter({ client: fake.client }).route(
        request({ signal: controller.signal }),
      ),
      "REQUEST_CANCELLED",
    );
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("classifies SDK timeouts as unavailable and sanitizes non-retryable provider failures", async () => {
    const timeoutCreate = vi.fn().mockRejectedValue(new Anthropic.APIConnectionTimeoutError());
    await expectRoutingCode(
      new AnthropicChatRouter({ client: clientFromCreate(timeoutCreate) }).route(request()),
      "PROVIDER_UNAVAILABLE",
    );

    const unavailableError = Anthropic.APIError.generate(
      503,
      { error: { type: "api_error", message: "sensitive transient payload" } },
      undefined,
      new Headers({ "request-id": "req_transient_123" }),
    );
    const unavailableCreate = vi.fn().mockRejectedValue(unavailableError);
    try {
      await new AnthropicChatRouter({ client: clientFromCreate(unavailableCreate) }).route(request());
      throw new Error("Expected route to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatRoutingError);
      expect((error as ChatRoutingError).code).toBe("PROVIDER_UNAVAILABLE");
      expect((error as Error).message).not.toContain("sensitive transient payload");
      expect((error as Error).cause).toBeUndefined();
    }

    const providerError = Anthropic.APIError.generate(
      400,
      { error: { type: "invalid_request_error", message: "sensitive provider payload" } },
      undefined,
      new Headers({ "request-id": "req_safe_123" }),
    );
    const rejectedCreate = vi.fn().mockRejectedValue(providerError);
    try {
      await new AnthropicChatRouter({ client: clientFromCreate(rejectedCreate) }).route(request());
      throw new Error("Expected route to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatRoutingError);
      expect((error as ChatRoutingError).code).toBe("PROVIDER_REQUEST_FAILED");
      expect((error as Error).message).toContain("status=400");
      expect((error as Error).message).toContain("req_safe_123");
      expect((error as Error).message).not.toContain("sensitive provider payload");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("honors timeout and effort environment configuration", async () => {
    vi.stubEnv("ANTHROPIC_CHAT_TIMEOUT_MS", "4321");
    vi.stubEnv("ANTHROPIC_CHAT_EFFORT", "high");
    const fake = fakeClient(message());
    const router = new AnthropicChatRouter({ client: fake.client });

    expect(router.requestTimeoutMs).toBe(4_321);
    await router.route(request());
    const body = fake.create.mock.calls[0]![0] as Record<string, unknown>;
    const options = fake.create.mock.calls[0]![1] as Record<string, unknown>;
    expect(body["output_config"]).toEqual({ effort: "high" });
    expect(options["timeout"]).toBe(4_321);
  });

  it("validates provider configuration before any request", () => {
    const fake = fakeClient(message());
    expect(() => new AnthropicChatRouter({ client: fake.client, timeoutMs: 999 })).toThrow(
      /timeout/u,
    );
    expect(() => new AnthropicChatRouter({ client: fake.client, maxToolCalls: 5 })).toThrow(
      /tool-call limit/u,
    );
    expect(() => new AnthropicChatRouter({ apiKey: "" })).toThrow(/ANTHROPIC_API_KEY/u);
  });
});
