import type { Locator } from "playwright";
import type {
  Action,
  CapabilityArtifact,
  Condition,
  LocatorStrategy,
  TargetRef,
  ValueExpr,
} from "../../domain/index.js";
import type { PlaywrightSurface } from "./playwrightSurface.js";

export interface ResolutionAttempt {
  strategy: LocatorStrategy;
  count: number;
}

export interface ResolvedTarget {
  target: TargetRef;
  locator: Locator;
  strategy: LocatorStrategy;
  attempts: ResolutionAttempt[];
}

export class TargetResolutionError extends Error {
  readonly code: "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "FRAME_NOT_FOUND";
  readonly targetId: string;
  readonly attempts: ResolutionAttempt[];

  constructor(options: {
    code: TargetResolutionError["code"];
    targetId: string;
    message: string;
    attempts?: ResolutionAttempt[];
  }) {
    super(options.message);
    this.name = "TargetResolutionError";
    this.code = options.code;
    this.targetId = options.targetId;
    this.attempts = options.attempts ?? [];
  }
}

export interface ArtifactActionReceipt {
  startedAt: string;
  completedAt: string;
  targetId?: string;
  strategy?: LocatorStrategy;
  attempts?: ResolutionAttempt[];
  observedValue?: string;
}

export interface ConditionEvaluation {
  matched: boolean;
  summary: string;
}

function cssString(value: string): string {
  return value.replace(/[\0-\x1f\x7f"\\]/gu, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\${code.toString(16)} `;
  });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export class PlaywrightArtifactRuntime {
  readonly #surface: PlaywrightSurface;
  readonly #targets: ReadonlyMap<string, TargetRef>;

  constructor(surface: PlaywrightSurface, artifact: Pick<CapabilityArtifact, "targets">) {
    this.#surface = surface;
    this.#targets = new Map(artifact.targets.map((target) => [target.id, target]));
  }

  getTarget(id: string): TargetRef {
    const target = this.#targets.get(id);
    if (!target) throw new Error(`Artifact references unknown target ${id}`);
    return target;
  }

  resolveValue(
    expression: ValueExpr,
    inputs: Record<string, string | number | boolean>,
  ): string | number | boolean | null {
    if (expression.kind === "literal") return expression.value;
    if (!Object.hasOwn(inputs, expression.name)) throw new Error(`Input ${expression.name} is not present`);
    return inputs[expression.name]!;
  }

  async resolve(targetId: string): Promise<ResolvedTarget> {
    const target = this.getTarget(targetId);
    let root = this.#surface.page.mainFrame();
    for (const segment of target.framePath) {
      const matching = [];
      for (const child of root.childFrames()) {
        const element = await child.frameElement();
        const title =
          (await element.getAttribute("title")) ??
          (await element.getAttribute("aria-label")) ??
          (await element.getAttribute("name"));
        if (title === segment.title) matching.push(child);
      }
      if (matching.length !== 1) {
        throw new TargetResolutionError({
          code: "FRAME_NOT_FOUND",
          targetId,
          message: `Frame ${JSON.stringify(segment.title)} resolved to ${matching.length}; expected exactly one.`,
        });
      }
      root = matching[0]!;
    }

    const attempts: ResolutionAttempt[] = [];
    for (const strategy of target.strategies) {
      const locator = this.#locator(root, strategy);
      const count = await locator.count();
      attempts.push({ strategy, count });
      if (count === 1) return { target, locator, strategy, attempts };
      if (count > 1) {
        throw new TargetResolutionError({
          code: "TARGET_AMBIGUOUS",
          targetId,
          message: `Strategy ${strategy.kind} for ${targetId} matched ${count} controls; refusing to choose one.`,
          attempts,
        });
      }
    }
    throw new TargetResolutionError({
      code: "TARGET_NOT_FOUND",
      targetId,
      message: `No reviewed strategy found target ${targetId}.`,
      attempts,
    });
  }

  async act(
    action: Action,
    inputs: Record<string, string | number | boolean>,
  ): Promise<ArtifactActionReceipt> {
    const startedAt = new Date().toISOString();
    if (action.kind === "press") {
      await this.#surface.page.keyboard.press(action.key);
      return { startedAt, completedAt: new Date().toISOString() };
    }
    const resolved = await this.resolve(action.targetId);
    let observedValue: string | undefined;
    switch (action.kind) {
      case "click":
        await resolved.locator.click();
        break;
      case "fill":
        await resolved.locator.fill(String(this.resolveValue(action.value, inputs) ?? ""));
        break;
      case "select": {
        const value = String(this.resolveValue(action.value, inputs) ?? "");
        const options = await resolved.locator.locator("option").evaluateAll((elements) =>
          elements.map((element) => ({
            value: (element as HTMLOptionElement).value,
            label: (element as HTMLOptionElement).label,
          })),
        );
        const exactLabel = options.filter((option) => option.label === value);
        const exactValue = options.filter((option) => option.value === value);
        if (exactLabel.length === 1) await resolved.locator.selectOption({ label: value });
        else if (exactValue.length === 1) await resolved.locator.selectOption({ value });
        else throw new Error(`Select value ${JSON.stringify(value)} did not match exactly one option`);
        break;
      }
      case "extract":
        observedValue = normalizeText(
          await resolved.locator.innerText().catch(async () => resolved.locator.inputValue()),
        );
        break;
    }
    await this.#surface.waitUntilReady();
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      targetId: action.targetId,
      strategy: resolved.strategy,
      attempts: resolved.attempts,
      ...(observedValue === undefined ? {} : { observedValue }),
    };
  }

  async evaluate(
    condition: Condition,
    inputs: Record<string, string | number | boolean>,
  ): Promise<ConditionEvaluation> {
    if (condition.kind === "all") {
      const results: ConditionEvaluation[] = [];
      for (const child of condition.conditions) results.push(await this.evaluate(child, inputs));
      const failed = results.filter((result) => !result.matched);
      return {
        matched: failed.length === 0,
        summary:
          failed.length === 0
            ? `All ${results.length} conditions matched.`
            : `${failed.length} of ${results.length} conditions failed: ${failed.map((item) => item.summary).join("; ")}`,
      };
    }
    switch (condition.kind) {
      case "target_visible": {
        try {
          const resolved = await this.resolve(condition.targetId);
          const visible = await resolved.locator.isVisible();
          return {
            matched: visible === condition.visible,
            summary: `Target ${condition.targetId} visible=${visible}; expected ${condition.visible}.`,
          };
        } catch (error) {
          if (
            error instanceof TargetResolutionError &&
            error.code === "TARGET_NOT_FOUND" &&
            condition.visible === false
          ) {
            return { matched: true, summary: `Target ${condition.targetId} is absent as expected.` };
          }
          return {
            matched: false,
            summary: error instanceof Error ? error.message : String(error),
          };
        }
      }
      case "target_value": {
        try {
          const resolved = await this.resolve(condition.targetId);
          const actual = normalizeText(
            await resolved.locator.inputValue().catch(async () => resolved.locator.innerText()),
          );
          const expected = String(this.resolveValue(condition.value, inputs) ?? "");
          let matched = false;
          if (condition.operator === "equals") matched = actual === expected;
          else if (condition.operator === "contains") matched = actual.includes(expected);
          else matched = new RegExp(expected, "u").test(actual);
          return {
            matched,
            summary: `Target ${condition.targetId} value ${condition.operator} expected value: ${matched}.`,
          };
        } catch (error) {
          return { matched: false, summary: error instanceof Error ? error.message : String(error) };
        }
      }
      case "frame_path": {
        let root = this.#surface.page.mainFrame();
        for (const segment of condition.framePath) {
          const matches = [];
          for (const child of root.childFrames()) {
            const element = await child.frameElement();
            const title =
              (await element.getAttribute("title")) ??
              (await element.getAttribute("aria-label")) ??
              (await element.getAttribute("name"));
            if (title === segment.title) matches.push(child);
          }
          if (matches.length !== 1) {
            return {
              matched: false,
              summary: `Frame ${JSON.stringify(segment.title)} resolved to ${matches.length}.`,
            };
          }
          root = matches[0]!;
        }
        return { matched: true, summary: "Frame path exists uniquely." };
      }
      case "text_visible": {
        let count = 0;
        for (const frame of this.#surface.page.frames()) {
          const locator = frame.getByText(condition.text, { exact: condition.exact });
          const candidates = await locator.count();
          for (let index = 0; index < candidates; index += 1) {
            if (await locator.nth(index).isVisible().catch(() => false)) count += 1;
          }
        }
        return {
          matched: count > 0,
          summary: `Visible text ${JSON.stringify(condition.text)} matched ${count} element(s).`,
        };
      }
    }
  }

  async waitFor(
    condition: Condition,
    inputs: Record<string, string | number | boolean>,
    timeoutMs: number,
  ): Promise<ConditionEvaluation> {
    const deadline = Date.now() + timeoutMs;
    let result = await this.evaluate(condition, inputs);
    while (!result.matched && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      result = await this.evaluate(condition, inputs);
    }
    return result;
  }

  #locator(root: ReturnType<PlaywrightSurface["page"]["mainFrame"]>, strategy: LocatorStrategy): Locator {
    switch (strategy.kind) {
      case "role":
        return root.getByRole(strategy.role as never, { name: strategy.name, exact: strategy.exact });
      case "label":
        return root.getByLabel(strategy.label, { exact: strategy.exact });
      case "name":
        return root.locator(`[name="${cssString(strategy.name)}"]`);
      case "text":
        return root.getByText(strategy.text, { exact: strategy.exact });
    }
  }
}
