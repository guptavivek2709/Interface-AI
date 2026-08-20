import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ChatRoutingError,
  type ChatToolDefinition,
} from "../../src/chat/contracts.js";
import {
  containsSecret,
  prepareChatTools,
  redactSecrets,
  validateToolInput,
} from "../../src/chat/security.js";

function tool(inputSchema: z.ZodType): ChatToolDefinition {
  return {
    name: "member_get_balance",
    capabilityId: "member.get_record_balance",
    capabilityVersion: "2.0.0",
    description: "Read the member record and return its current share balances.",
    inputSchema,
  };
}

function expectRoutingCode(action: () => unknown, code: ChatRoutingError["code"]): void {
  try {
    action();
    throw new Error("Expected action to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRoutingError);
    expect((error as ChatRoutingError).code).toBe(code);
  }
}

describe("chat security contracts", () => {
  it("derives a closed JSON schema from the same Zod validator used locally", () => {
    const prepared = prepareChatTools([
      tool(
        z.strictObject({
          memberId: z.string().regex(/^\d{6}$/u),
          options: z.strictObject({ includeClosed: z.boolean() }).optional(),
        }),
      ),
    ])[0]!;

    expect(prepared.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        memberId: { type: "string" },
        options: { type: "object", additionalProperties: false },
      },
    });
    expect(prepared.jsonSchema["$schema"]).toBeUndefined();
    expect(validateToolInput(prepared, { memberId: "100234" })).toEqual({ memberId: "100234" });
  });

  it("rejects unknown keys and invalid values even if a provider claims strict conformance", () => {
    const prepared = prepareChatTools([
      tool(z.object({ memberId: z.string().regex(/^\d{6}$/u) })),
    ])[0]!;

    expectRoutingCode(
      () => validateToolInput(prepared, { memberId: "100234", role: "supervisor" }),
      "INVALID_TOOL_INPUT",
    );
    expectRoutingCode(
      () => validateToolInput(prepared, { memberId: "not-a-number" }),
      "INVALID_TOOL_INPUT",
    );
  });

  it("detects nested keys stripped by a permissive validator", () => {
    const prepared = prepareChatTools([
      tool(z.object({ options: z.object({ includeClosed: z.boolean() }) })),
    ])[0]!;
    expectRoutingCode(
      () =>
        validateToolInput(prepared, {
          options: { includeClosed: false, supervisorOverride: true },
        }),
      "INVALID_TOOL_INPUT",
    );
  });

  it.each(["password", "apiKey", "access_token", "csrfToken", "privateKey"])(
    "does not allow a model-visible %s field",
    (field) => {
      expectRoutingCode(
        () => prepareChatTools([tool(z.strictObject({ [field]: z.string() }))]),
        "INVALID_TOOL_DEFINITION",
      );
    },
  );

  it("requires closed nested object schemas", () => {
    expectRoutingCode(
      () => prepareChatTools([tool(z.looseObject({ memberId: z.string() }))]),
      "INVALID_TOOL_DEFINITION",
    );
  });

  it("blocks known or obvious secrets hidden in otherwise valid string arguments", () => {
    const prepared = prepareChatTools([
      tool(z.strictObject({ memberId: z.string(), memo: z.string() })),
    ])[0]!;

    expectRoutingCode(
      () =>
        validateToolInput(
          prepared,
          { memberId: "100234", memo: "password=hunter2" },
          ["known-secret"],
        ),
      "SECRET_INPUT_BLOCKED",
    );
    expectRoutingCode(
      () =>
        validateToolInput(
          prepared,
          { memberId: "100234", memo: "please use known-secret" },
          ["known-secret"],
        ),
      "SECRET_INPUT_BLOCKED",
    );
  });

  it("redacts common credential forms without removing ordinary password discussion", () => {
    const input = [
      "I forgot my password.",
      "password=hunter2",
      "Authorization: Bearer abc.def.ghi",
      "key sk-ant-1234567890abcdef",
      "https://operator:secret@example.test/path",
      "exact KNOWN_VALUE",
    ].join("\n");
    const output = redactSecrets(input, ["KNOWN_VALUE"]);

    expect(output).toContain("I forgot my password.");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("abc.def.ghi");
    expect(output).not.toContain("sk-ant-");
    expect(output).not.toContain("operator:secret");
    expect(output).not.toContain("KNOWN_VALUE");
    expect(containsSecret(input, ["KNOWN_VALUE"])).toBe(true);
  });
});
