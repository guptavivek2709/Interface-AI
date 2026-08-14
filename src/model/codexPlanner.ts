import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeDecision,
  plannerPrompt,
  type Planner,
  type PlannerRequest,
  type PlannerResponse,
} from "./planner.js";

function execFileWithClosedStdin(
  command: string,
  args: string[],
  options: {
    cwd: string;
    windowsHide: boolean;
    timeout: number;
    maxBuffer: number;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(command, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
    // Codex optionally reads more prompt text from stdin. execFile creates a
    // writable pipe by default; without an explicit EOF the CLI waits forever.
    child.stdin?.end();
  });
}

export class CodexPlanner implements Planner {
  readonly name = "openai-codex-cli";
  readonly model: string;
  readonly #command: string;
  readonly #timeoutMs: number;

  constructor(options?: { command?: string; model?: string; timeoutMs?: number }) {
    this.#command = options?.command ?? process.env.CODEX_CLI_PATH ?? "codex";
    this.model = options?.model ?? process.env.CODEX_MODEL ?? "gpt-5.6-terra";
    const configuredTimeout = options?.timeoutMs ?? Number(process.env.CODEX_CALL_TIMEOUT_MS ?? 120_000);
    if (!Number.isInteger(configuredTimeout) || configuredTimeout < 1_000 || configuredTimeout > 900_000) {
      throw new Error("Codex call timeout must be an integer from 1000 through 900000 milliseconds");
    }
    this.#timeoutMs = configuredTimeout;
  }

  async decide(request: PlannerRequest): Promise<PlannerResponse> {
    const started = Date.now();
    const scratch = await mkdtemp(path.join(tmpdir(), "capability-codex-"));
    const outputPath = path.join(scratch, "decision.json");
    const schemaPath = path.resolve(process.cwd(), "schemas", "planner-decision.schema.json");
    try {
      await execFileWithClosedStdin(
        this.#command,
        [
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "--model",
          this.model,
          "-c",
          'model_reasoning_effort="low"',
          "--image",
          request.observation.screenshotPath,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          plannerPrompt(request),
        ],
        {
          cwd: process.cwd(),
          windowsHide: true,
          timeout: this.#timeoutMs,
          maxBuffer: 5 * 1024 * 1024,
        },
      );
      const raw = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
      return {
        decision: normalizeDecision(raw),
        metadata: {
          provider: this.name,
          model: this.model,
          responseId: null,
          latencyMs: Date.now() - started,
        },
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
