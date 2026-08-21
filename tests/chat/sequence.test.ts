import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ChatRoutingError,
  ChatSequenceRouteSchema,
  type ChatToolDefinition,
} from "../../src/chat/contracts.js";
import { prepareChatTools } from "../../src/chat/security.js";
import {
  buildChatSequenceRoute,
  compileSequenceProposalTool,
  parseSequenceProviderInput,
  validateChatSequenceSteps,
} from "../../src/chat/sequence.js";

const SEARCH: ChatToolDefinition = {
  name: "member_search_by_last_name",
  capabilityId: "member.search_by_last_name",
  capabilityVersion: "2.0.0",
  description: "Return every matching member row without silently choosing among duplicate names.",
  inputSchema: z.strictObject({ last_name: z.string().min(1).max(64) }),
  outputSchema: z.strictObject({
    candidates: z.array(z.strictObject({
      member_number: z.string().regex(/^\d{6}$/u).meta({ format: "member_number" }),
      name: z.string(),
      share_count: z.number().int(),
    })).max(100),
  }),
};

const BALANCES: ChatToolDefinition = {
  name: "member_get_record_and_balances",
  capabilityId: "member.get_record_and_balances",
  capabilityVersion: "2.0.0",
  description: "Read one exact member record and return all current structured share balances.",
  inputSchema: z.strictObject({
    member_number: z.string().regex(/^\d{6}$/u).meta({ format: "member_number" }),
    include_closed: z.boolean().optional(),
  }),
  outputSchema: z.strictObject({ shares: z.array(z.strictObject({ share_id: z.string() })) }),
};

const METADATA = {
  provider: "test",
  model: "test-model",
  responseId: "response-1",
  latencyMs: 1,
} as const;

function binding(overrides: Record<string, unknown> = {}) {
  return {
    sourceStepId: "search",
    sourceCollectionPath: ["candidates"],
    valuePath: ["member_number"],
    targetInput: "member_number",
    selection: "exactly_one",
    onZero: "stop_no_match",
    onMany: "pause_for_authenticated_selection",
    ...overrides,
  };
}

function draft(): Array<Record<string, unknown>> {
  return [
    {
      stepId: "search",
      toolName: SEARCH.name,
      literalArguments: { last_name: "Smith" },
      bindings: [],
    },
    {
      stepId: "balances",
      toolName: BALANCES.name,
      literalArguments: { include_closed: false },
      bindings: [binding()],
    },
  ];
}

function expectCode(action: () => unknown, code: ChatRoutingError["code"]): void {
  try {
    action();
    throw new Error("Expected sequence validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRoutingError);
    expect((error as ChatRoutingError).code).toBe(code);
  }
}

describe("typed chat sequence contract", () => {
  it("derives exact capability identities for an ordered prior-output binding", () => {
    const route = buildChatSequenceRoute({
      toolCallId: "toolu_sequence_1",
      draftSteps: draft(),
      assistantText: "I will search first and continue only after an exact member choice.",
      metadata: METADATA,
      tools: prepareChatTools([SEARCH, BALANCES]),
    });

    expect(route).toEqual({
      kind: "sequence",
      toolCallId: "toolu_sequence_1",
      failurePolicy: "stop_on_non_success",
      assistantText: "I will search first and continue only after an exact member choice.",
      metadata: METADATA,
      steps: [
        expect.objectContaining({
          stepId: "search",
          capabilityId: SEARCH.capabilityId,
          capabilityVersion: SEARCH.capabilityVersion,
          literalArguments: { last_name: "Smith" },
          bindings: [],
        }),
        expect.objectContaining({
          stepId: "balances",
          capabilityId: BALANCES.capabilityId,
          capabilityVersion: BALANCES.capabilityVersion,
          literalArguments: { include_closed: false },
          bindings: [binding()],
        }),
      ],
    });
  });

  it("allows one through three ordered steps but rejects a fourth", () => {
    const tools = prepareChatTools([SEARCH, BALANCES]);
    expect(validateChatSequenceSteps(tools, [draft()[0]])).toHaveLength(1);
    expect(validateChatSequenceSteps(tools, [...draft(), {
      stepId: "balances_again",
      toolName: BALANCES.name,
      literalArguments: { member_number: "100234" },
      bindings: [],
    }])).toHaveLength(3);
    expectCode(
      () => validateChatSequenceSteps(tools, [...draft(), draft()[0], draft()[1]]),
      "PROVIDER_RESPONSE_INVALID",
    );
  });

  it("rejects forward references, duplicate targets, and literal overrides of a binding", () => {
    const tools = prepareChatTools([SEARCH, BALANCES]);
    const forward = draft();
    forward[0] = { ...forward[0]!, bindings: [binding({ sourceStepId: "balances", targetInput: "last_name", valuePath: ["name"] })] };
    expectCode(() => validateChatSequenceSteps(tools, forward), "PROVIDER_RESPONSE_INVALID");

    const duplicate = draft();
    duplicate[1] = { ...duplicate[1]!, bindings: [binding(), binding()] };
    expectCode(() => validateChatSequenceSteps(tools, duplicate), "INVALID_TOOL_INPUT");

    const override = draft();
    override[1] = { ...override[1]!, literalArguments: { member_number: "100234" } };
    expectCode(() => validateChatSequenceSteps(tools, override), "INVALID_TOOL_INPUT");
  });

  it("requires every missing required input to have a valid typed collection binding", () => {
    const tools = prepareChatTools([SEARCH, BALANCES]);
    const missing = draft();
    missing[1] = { ...missing[1]!, bindings: [] };
    expectCode(() => validateChatSequenceSteps(tools, missing), "INVALID_TOOL_INPUT");

    const scalarSource = draft();
    scalarSource[1] = { ...scalarSource[1]!, bindings: [binding({ sourceCollectionPath: ["unknown"] })] };
    expectCode(() => validateChatSequenceSteps(tools, scalarSource), "INVALID_TOOL_INPUT");

    const incompatible = draft();
    incompatible[1] = { ...incompatible[1]!, bindings: [binding({ valuePath: ["share_count"] })] };
    expectCode(() => validateChatSequenceSteps(tools, incompatible), "INVALID_TOOL_INPUT");
  });

  it("blocks secrets in literal arguments and keeps digest/idempotency authority out of model routes", () => {
    const secret = draft();
    secret[0] = { ...secret[0]!, literalArguments: { last_name: "password=hunter2" } };
    expectCode(
      () => validateChatSequenceSteps(prepareChatTools([SEARCH, BALANCES]), secret),
      "SECRET_INPUT_BLOCKED",
    );

    const route = buildChatSequenceRoute({
      toolCallId: "toolu_sequence_2",
      draftSteps: draft(),
      assistantText: null,
      metadata: METADATA,
      tools: prepareChatTools([SEARCH, BALANCES]),
    });
    expect(() => ChatSequenceRouteSchema.parse({
      ...route,
      artifactDigest: "a".repeat(64),
      idempotencyKey: "model-key",
    })).toThrow();
    expect(JSON.stringify(route)).not.toContain("artifactDigest");
    expect(JSON.stringify(route)).not.toContain("idempotency");
  });

  it("exposes one strict provider meta-tool and reparses every literal argument object locally", () => {
    const tools = prepareChatTools([SEARCH, BALANCES]);
    const providerTool = compileSequenceProposalTool(tools);
    expect(providerTool).toMatchObject({
      name: "propose_capability_sequence",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              additionalProperties: false,
              properties: {
                toolName: { enum: [SEARCH.name, BALANCES.name] },
                bindings: { maxItems: 16 },
              },
            },
          },
        },
      },
    });
    expect(providerTool.description).toContain("member_search_by_last_name outputs [candidates]");

    const parsed = parseSequenceProviderInput({
      steps: [
        { stepId: "search", toolName: SEARCH.name, literalArgumentsJson: '{"last_name":"Smith"}', bindings: [] },
        { stepId: "balances", toolName: BALANCES.name, literalArgumentsJson: "{}", bindings: [binding()] },
      ],
    });
    expect(validateChatSequenceSteps(tools, parsed)).toHaveLength(2);
    expectCode(
      () => parseSequenceProviderInput({
        steps: [{ stepId: "search", toolName: SEARCH.name, literalArgumentsJson: "not-json", bindings: [] }],
      }),
      "INVALID_TOOL_INPUT",
    );
    expectCode(
      () => parseSequenceProviderInput({
        steps: [{ stepId: "search", toolName: SEARCH.name, literalArgumentsJson: "{}", bindings: [], artifactDigest: "forged" }],
      }),
      "PROVIDER_RESPONSE_INVALID",
    );
  });
});
