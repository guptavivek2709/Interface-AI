import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ChatRoutingError,
  type ChatRouteRequest,
  type ChatToolDefinition,
} from "../../src/chat/contracts.js";
import { DeterministicChatRouter } from "../../src/chat/deterministicRouter.js";

const TOOL: ChatToolDefinition = {
  name: "member_get_balance",
  capabilityId: "member.get_record_balance",
  capabilityVersion: "2.0.0",
  description: "Read one member record and return all of its structured share balances.",
  inputSchema: z.strictObject({ memberId: z.string().regex(/^\d{6}$/u) }),
};

function request(message: string): ChatRouteRequest {
  return { message, tools: [TOOL] };
}

describe("DeterministicChatRouter", () => {
  it("routes explicit offline commands through the same local validator", async () => {
    const result = await new DeterministicChatRouter().route(
      request('/run member_get_balance {"memberId":"100234"}'),
    );
    expect(result).toMatchObject({
      kind: "invoke",
      capabilityId: "member.get_record_balance",
      arguments: { memberId: "100234" },
      metadata: { provider: "deterministic-offline", model: null },
    });
  });

  it("lists capabilities and never guesses a natural-language route", async () => {
    const router = new DeterministicChatRouter();
    await expect(router.route(request("/capabilities"))).resolves.toMatchObject({
      kind: "reply",
      text: expect.stringContaining("member_get_balance"),
    });
    await expect(router.route(request("show the balance for 100234"))).resolves.toMatchObject({
      kind: "reply",
      text: expect.stringContaining("No capability was started"),
    });
  });

  it("rejects malformed and invalid JSON arguments", async () => {
    const router = new DeterministicChatRouter();
    await expect(router.route(request("/run member_get_balance nope"))).rejects.toMatchObject({
      code: "INVALID_TOOL_INPUT",
    });
    await expect(
      router.route(request('/run member_get_balance {"memberId":"wrong"}')),
    ).rejects.toBeInstanceOf(ChatRoutingError);
  });
});
