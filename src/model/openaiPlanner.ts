import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  PlannerDecisionSchema,
  normalizeDecision,
  plannerPrompt,
  type Planner,
  type PlannerRequest,
  type PlannerResponse,
} from "./planner.js";

export class OpenAIPlanner implements Planner {
  readonly name = "openai-responses";
  readonly model: string;
  readonly #client: OpenAI;

  constructor(options?: { apiKey?: string; model?: string }) {
    this.model = options?.model ?? process.env.OPENAI_MODEL ?? "gpt-5.6-terra";
    this.#client = new OpenAI({ apiKey: options?.apiKey ?? process.env.OPENAI_API_KEY });
  }

  async decide(request: PlannerRequest): Promise<PlannerResponse> {
    const started = Date.now();
    const image = await readFile(request.observation.screenshotPath);
    const response = await this.#client.responses.parse({
      model: this.model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: plannerPrompt(request) },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${image.toString("base64")}`,
              detail: "high",
            },
          ],
        },
      ],
      text: { format: zodTextFormat(PlannerDecisionSchema, "planner_decision") },
      store: false,
    });

    return {
      decision: normalizeDecision(response.output_parsed),
      metadata: {
        provider: this.name,
        model: this.model,
        responseId: response.id,
        latencyMs: Date.now() - started,
      },
    };
  }
}
