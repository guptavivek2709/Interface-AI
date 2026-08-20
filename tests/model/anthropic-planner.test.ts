import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicPlanner,
  type AnthropicPlannerOptions,
} from "../../src/model/anthropicPlanner.js";
import type { PlannerRequest } from "../../src/model/planner.js";

type TestClient = NonNullable<AnthropicPlannerOptions["client"]>;

const VALID_DECISION = {
  decision: "finish",
  reason: "The requested checkpoint is visible.",
  action: null,
  checkpointText: "Review ready",
  escalationReason: null,
};

function fakeClient(response: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue(response);
  return {
    create,
    client: { messages: { create } } as unknown as TestClient,
  };
}

describe("AnthropicPlanner", () => {
  let scratch: string | undefined;

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  async function request(): Promise<PlannerRequest> {
    scratch ??= await mkdtemp(path.join(tmpdir(), "capability-anthropic-test-"));
    const screenshotPath = path.join(scratch, "observation.png");
    await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return {
      goal: "Finish at Review ready.",
      inputs: { memberId: "SYNTHETIC-1" },
      history: [],
      maxSteps: 24,
      currentStep: 1,
      observation: {
        capturedAt: "2026-08-19T00:00:00.000Z",
        url: "http://127.0.0.1:4317/",
        title: "Synthetic bank",
        httpStatus: 200,
        controls: [],
        frames: [],
        visibleText: "Review ready",
        stateHash: "abc",
        screenshotPath,
      },
    };
  }

  it("sends a PNG plus prompt under a structured schema and normalizes the decision", async () => {
    const fake = fakeClient({
      id: "msg_test_123",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(VALID_DECISION) }],
    });
    const planner = new AnthropicPlanner({
      client: fake.client,
      model: "claude-sonnet-5",
      effort: "medium",
    });

    const result = await planner.decide(await request());
    expect(result.decision).toEqual(VALID_DECISION);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        provider: "anthropic-messages",
        model: "claude-sonnet-5",
        responseId: "msg_test_123",
      }),
    );

    const body = fake.create.mock.calls[0]![0] as {
      model: string;
      max_tokens: number;
      output_config: { effort: string; format: { type: string } };
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(4_096);
    expect(body.output_config.effort).toBe("medium");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0]!.content[0]).toEqual(
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({ type: "base64", media_type: "image/png", data: "iVBORw==" }),
      }),
    );
    expect(body.messages[0]!.content[1]?.["text"]).toContain("Finish at Review ready");
  });

  it.each(["refusal", "max_tokens", "tool_use"])("rejects stop reason %s", async (stopReason) => {
    const fake = fakeClient({
      id: "msg_stopped",
      stop_reason: stopReason,
      content: [{ type: "text", text: JSON.stringify(VALID_DECISION) }],
    });
    const planner = new AnthropicPlanner({ client: fake.client });
    await expect(planner.decide(await request())).rejects.toThrow(/Anthropic/u);
  });

  it("rejects malformed or semantically invalid model output", async () => {
    const malformed = fakeClient({
      id: "msg_bad_json",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not-json" }],
    });
    await expect(new AnthropicPlanner({ client: malformed.client }).decide(await request())).rejects.toThrow(
      /valid JSON/u,
    );

    const invalid = fakeClient({
      id: "msg_bad_shape",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ ...VALID_DECISION, checkpointText: null }) }],
    });
    await expect(new AnthropicPlanner({ client: invalid.client }).decide(await request())).rejects.toThrow();
  });

  it("validates local configuration before making a request", () => {
    const fake = fakeClient({});
    expect(() => new AnthropicPlanner({ client: fake.client, timeoutMs: 999 })).toThrow(/timeout/u);
    expect(() => new AnthropicPlanner({ client: fake.client, timeoutMs: 900_001 })).toThrow(/timeout/u);
    expect(() => new AnthropicPlanner({ client: fake.client, effort: "invalid" as "medium" })).toThrow(
      /ANTHROPIC_EFFORT/u,
    );
    expect(() => new AnthropicPlanner({ apiKey: "" })).toThrow(/ANTHROPIC_API_KEY/u);
  });
});
