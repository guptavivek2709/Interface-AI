import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileAnthropicToolSchema,
  compileAnthropicTools,
} from "../../src/chat/anthropicSchema.js";
import {
  ChatRoutingError,
  type ChatToolDefinition,
  type JsonObject,
} from "../../src/chat/contracts.js";
import {
  prepareChatTools,
  validateToolInput,
} from "../../src/chat/security.js";

function tool(
  inputSchema: z.ZodType,
  name = "provider_schema_test",
): ChatToolDefinition {
  return {
    name,
    capabilityId: `test.${name}`,
    capabilityVersion: "1.0.0",
    description: "Exercise provider schema normalization without executing a capability.",
    inputSchema,
  };
}

function expectRoutingCode(
  action: () => unknown,
  code: ChatRoutingError["code"],
): void {
  try {
    action();
    throw new Error("Expected action to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRoutingError);
    expect((error as ChatRoutingError).code).toBe(code);
  }
}

function schemaKeys(value: unknown, keys = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => schemaKeys(item, keys));
    return keys;
  }
  if (value === null || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    schemaKeys(child, keys);
  }
  return keys;
}

function property(schema: JsonObject, name: string): JsonObject {
  const properties = schema["properties"];
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Expected object properties");
  }
  const result = properties[name];
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`Expected schema for ${name}`);
  }
  return result as JsonObject;
}

describe("Anthropic strict tool schema compiler", () => {
  it("removes Zod's incompatible email regex only from the provider projection", () => {
    const prepared = prepareChatTools([
      tool(z.strictObject({ email: z.string().email() })),
    ])[0]!;
    const canonicalBefore = structuredClone(prepared.jsonSchema);
    const canonicalEmail = property(prepared.jsonSchema, "email");

    expect(canonicalEmail["format"]).toBe("email");
    expect(canonicalEmail["pattern"]).toEqual(expect.stringContaining("(?!"));

    const provider = compileAnthropicTools([prepared])[0]!.inputSchema;
    expect(schemaKeys(provider)).not.toContain("pattern");
    expect(property(provider, "email")["format"]).toBe("email");
    expect(JSON.stringify(provider)).toContain("pattern");
    expect(prepared.jsonSchema).toEqual(canonicalBefore);

    expect(validateToolInput(prepared, { email: "valid@example.test" })).toEqual({
      email: "valid@example.test",
    });
    expectRoutingCode(
      () => validateToolInput(prepared, { email: "not-an-email" }),
      "INVALID_TOOL_INPUT",
    );
  });

  it("handles an explicit pattern combined with email format without weakening local checks", () => {
    const prepared = prepareChatTools([
      tool(
        z.strictObject({
          email: z.string().regex(/^[a-z]+@example[.]com$/u).email(),
        }),
      ),
    ])[0]!;

    const provider = compileAnthropicTools([prepared])[0]!.inputSchema;
    expect(schemaKeys(provider)).not.toContain("pattern");
    expect(property(provider, "email")["format"]).toBe("email");
    expect(JSON.stringify(provider)).toContain("^[a-z]+@example[.]com$");
    expect(validateToolInput(prepared, { email: "alice@example.com" })).toEqual({
      email: "alice@example.com",
    });
    expectRoutingCode(
      () => validateToolInput(prepared, { email: "alice@elsewhere.test" }),
      "INVALID_TOOL_INPUT",
    );
  });

  it("retains useful explicit patterns as provider guidance and authoritative local validation", () => {
    const prepared = prepareChatTools([
      tool(
        z.strictObject({
          routingCode: z.string().regex(/^[A-Z]{2}-\d{4}$/u),
        }),
      ),
    ])[0]!;
    const provider = compileAnthropicTools([prepared])[0]!.inputSchema;
    const providerField = property(provider, "routingCode");

    expect(providerField["pattern"]).toBeUndefined();
    expect(providerField["description"]).toEqual(expect.stringContaining("pattern"));
    expect(providerField["description"]).toEqual(expect.stringContaining("[A-Z]{2}"));
    expect(validateToolInput(prepared, { routingCode: "AB-1234" })).toEqual({
      routingCode: "AB-1234",
    });
    expectRoutingCode(
      () => validateToolInput(prepared, { routingCode: "ab-1234" }),
      "INVALID_TOOL_INPUT",
    );
  });

  it("deliberately lowers unsupported value constraints to descriptions but validates locally", () => {
    const prepared = prepareChatTools([
      tool(
        z.strictObject({
          count: z.number().int().min(2).max(9),
          label: z.string().min(3).max(8),
        }),
      ),
    ])[0]!;
    const provider = compileAnthropicTools([prepared])[0]!.inputSchema;
    const keys = schemaKeys(provider);

    expect(keys).not.toContain("minimum");
    expect(keys).not.toContain("maximum");
    expect(keys).not.toContain("minLength");
    expect(keys).not.toContain("maxLength");
    expect(JSON.stringify(provider)).toContain("minimum");
    expect(JSON.stringify(provider)).toContain("minLength");
    expect(validateToolInput(prepared, { count: 3, label: "valid" })).toEqual({
      count: 3,
      label: "valid",
    });
    expectRoutingCode(
      () => validateToolInput(prepared, { count: 1, label: "x" }),
      "INVALID_TOOL_INPUT",
    );
  });

  it("preserves provider-supported enums while keeping the Zod schema authoritative", () => {
    const prepared = prepareChatTools([
      tool(z.strictObject({ channel: z.enum(["branch", "phone"]) })),
    ])[0]!;
    const provider = compileAnthropicTools([prepared])[0]!.inputSchema;

    expect(property(provider, "channel")["enum"]).toEqual(["branch", "phone"]);
    expect(validateToolInput(prepared, { channel: "branch" })).toEqual({ channel: "branch" });
    expectRoutingCode(
      () => validateToolInput(prepared, { channel: "untrusted" }),
      "INVALID_TOOL_INPUT",
    );
  });

  it("fails closed when a Zod construct cannot be represented or a reference is unsafe", () => {
    expectRoutingCode(
      () =>
        prepareChatTools([
          tool(z.strictObject({ value: z.string().transform((item) => item.trim()) })),
        ]),
      "INVALID_TOOL_DEFINITION",
    );

    expectRoutingCode(
      () =>
        compileAnthropicToolSchema({
          type: "object",
          properties: { value: { $ref: "https://example.test/schema.json" } },
          required: ["value"],
          additionalProperties: false,
        }),
      "INVALID_TOOL_DEFINITION",
    );
  });

  it("preflights Anthropic's combined strict-tool complexity limits", () => {
    const twentyOne = Array.from({ length: 21 }, (_, index) =>
      tool(z.strictObject({ value: z.string() }), `tool_${index}`));
    expectRoutingCode(
      () => compileAnthropicTools(prepareChatTools(twentyOne)),
      "INVALID_TOOL_DEFINITION",
    );

    const optionalShape = (prefix: string): Record<string, z.ZodType> =>
      Object.fromEntries(
        Array.from({ length: 13 }, (_, index) => [
          `${prefix}_${index}`,
          z.string().optional(),
        ]),
      );
    const optionalTools = prepareChatTools([
      tool(z.strictObject(optionalShape("left")), "optional_left"),
      tool(z.strictObject(optionalShape("right")), "optional_right"),
    ]);
    expectRoutingCode(
      () => compileAnthropicTools(optionalTools),
      "INVALID_TOOL_DEFINITION",
    );

    const unionShape = (prefix: string, count: number): Record<string, z.ZodType> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `${prefix}_${index}`,
          z.union([z.string(), z.number()]),
        ]),
      );
    const unionTools = prepareChatTools([
      tool(z.strictObject(unionShape("left", 9)), "union_left"),
      tool(z.strictObject(unionShape("right", 8)), "union_right"),
    ]);
    expectRoutingCode(
      () => compileAnthropicTools(unionTools),
      "INVALID_TOOL_DEFINITION",
    );
  });
});
