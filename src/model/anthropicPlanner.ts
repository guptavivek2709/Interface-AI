import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  PlannerDecisionSchema,
  normalizeDecision,
  plannerPrompt,
  type Planner,
  type PlannerRequest,
  type PlannerResponse,
} from "./planner.js";

type AnthropicClient = Pick<Anthropic, "messages">;
type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicPlannerOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  effort?: AnthropicEffort;
  /** Test seam; production callers should provide an API key instead. */
  client?: AnthropicClient;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export class AnthropicPlanner implements Planner {
  readonly name = "anthropic-messages";
  readonly model: string;
  readonly #client: AnthropicClient;
  readonly #maxTokens: number;
  readonly #effort: AnthropicEffort;

  constructor(options?: AnthropicPlannerOptions) {
    this.model = options?.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    if (!this.model.trim()) throw new Error("Anthropic model cannot be empty");

    const timeoutMs = boundedInteger(
      options?.timeoutMs ?? Number(process.env.ANTHROPIC_CALL_TIMEOUT_MS ?? 120_000),
      "Anthropic call timeout",
      1_000,
      900_000,
    );
    this.#maxTokens = boundedInteger(
      options?.maxTokens ?? 4_096,
      "Anthropic max tokens",
      256,
      128_000,
    );
    const effort = options?.effort ?? process.env.ANTHROPIC_EFFORT ?? "medium";
    if (
      !(
        effort === "low" ||
        effort === "medium" ||
        effort === "high" ||
        effort === "xhigh" ||
        effort === "max"
      )
    ) {
      throw new Error("ANTHROPIC_EFFORT must be low, medium, high, xhigh, or max");
    }
    this.#effort = effort;

    if (options?.client) {
      this.#client = options.client;
      return;
    }

    const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey?.trim()) {
      throw new Error("ANTHROPIC_API_KEY is required for --planner anthropic");
    }
    this.#client = new Anthropic({
      apiKey,
      timeout: timeoutMs,
      maxRetries: 0,
      logLevel: "warn",
    });
  }

  async decide(request: PlannerRequest): Promise<PlannerResponse> {
    const started = Date.now();
    const image = await readFile(request.observation.screenshotPath);
    let response;
    try {
      response = await this.#client.messages.create({
        model: this.model,
        max_tokens: this.#maxTokens,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: image.toString("base64"),
                },
              },
              { type: "text", text: plannerPrompt(request) },
            ],
          },
        ],
        output_config: {
          effort: this.#effort,
          format: zodOutputFormat(PlannerDecisionSchema),
        },
      });
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionTimeoutError) {
        throw new Error("Anthropic planner request timed out");
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(
          `Anthropic planner request failed (${error.name}; status=${error.status ?? "connection"}; requestId=${error.requestID ?? "unavailable"})`,
        );
      }
      throw error;
    }

    if (response.stop_reason === "refusal") {
      throw new Error(`Anthropic refused planner decision ${response.id}`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`Anthropic planner decision ${response.id} exceeded max_tokens`);
    }
    if (response.stop_reason !== "end_turn") {
      throw new Error(
        `Anthropic planner decision ${response.id} stopped unexpectedly (${response.stop_reason ?? "unknown"})`,
      );
    }

    const textBlocks = response.content.filter((block) => block.type === "text");
    if (textBlocks.length !== 1) {
      throw new Error(
        `Anthropic planner decision ${response.id} returned ${textBlocks.length} text blocks; expected exactly one`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(textBlocks[0]!.text) as unknown;
    } catch (error) {
      throw new Error(`Anthropic planner decision ${response.id} was not valid JSON`, { cause: error });
    }

    return {
      decision: normalizeDecision(raw),
      metadata: {
        provider: this.name,
        model: this.model,
        responseId: response.id,
        latencyMs: Date.now() - started,
      },
    };
  }
}
