import type {
  ActionV2,
  ConditionV2,
  TargetV2,
  TypeSpecV2,
  ValueExprV2,
} from "../domain/index.js";

export type RuntimeScalar = string | number | boolean | null;
export type RuntimeValue = RuntimeScalar | RuntimeValue[] | { [key: string]: RuntimeValue };

export interface RuntimeContextV2 {
  inputs: Readonly<Record<string, RuntimeValue>>;
  bindings: Record<string, RuntimeValue>;
}

export interface RuntimeResolutionAttemptV2 {
  strategy: string;
  count: number;
  summary: string;
}

export interface RuntimeActionResultV2 {
  startedAt: string;
  completedAt: string;
  targetId?: string;
  outputName?: string;
  bindingName?: string;
  value?: RuntimeValue;
  strategy?: string;
  attempts: RuntimeResolutionAttemptV2[];
}

export interface RuntimeConditionResultV2 {
  matched: boolean;
  summary: string;
}

export interface RuntimePageStateV2 {
  url: string;
  title: string;
  httpStatus: number | null;
  method: "GET" | "POST" | null;
}

/**
 * Surface-neutral execution seam for V2 replay. Browser, desktop, or future
 * computer-use adapters implement this contract; the deterministic runner does
 * not import Playwright.
 */
export interface ReplayRuntimeV2 {
  readonly sessionId: string;
  readonly sessionRef: string;
  getTarget(id: string): TargetV2;
  resolveValue(expression: ValueExprV2, context: RuntimeContextV2): RuntimeValue;
  act(action: ActionV2, context: RuntimeContextV2): Promise<RuntimeActionResultV2>;
  evaluate(condition: ConditionV2, context: RuntimeContextV2): Promise<RuntimeConditionResultV2>;
  waitFor(
    condition: ConditionV2,
    context: RuntimeContextV2,
    timeoutMs: number,
  ): Promise<RuntimeConditionResultV2>;
  pageState(): Promise<RuntimePageStateV2>;
  captureMaskedScreenshot(): Promise<Buffer>;
  sanitizedDomSnapshot(): Promise<string>;
  close(): Promise<void>;
}

export function parseRuntimeValue(type: TypeSpecV2, observed: string): RuntimeValue {
  const text = observed.replace(/\s+/gu, " ").trim();
  switch (type.kind) {
    case "string":
      return text;
    case "boolean": {
      const normalized = text.toLocaleLowerCase("en-US");
      if (normalized === "true" || normalized === "yes" || normalized === "open") return true;
      if (normalized === "false" || normalized === "no" || normalized === "closed") return false;
      throw new Error(`Expected boolean text, received ${JSON.stringify(text)}`);
    }
    case "number": {
      const normalized = text.replaceAll(",", "");
      if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(normalized)) {
        throw new Error(`Expected numeric text, received ${JSON.stringify(text)}`);
      }
      const value = Number(normalized);
      if (!Number.isFinite(value) || (type.integer === true && !Number.isInteger(value))) {
        throw new Error(`Observed number does not satisfy the declared type`);
      }
      return value;
    }
    case "money": {
      const normalized = text
        .replace(new RegExp(`^${type.currency}\\s*`, "u"), "")
        .replace(/^[$€£]\s*/u, "")
        .replaceAll(",", "");
      const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(normalized);
      if (!match) throw new Error(`Expected money text, received ${JSON.stringify(text)}`);
      const fraction = (match[3] ?? "").padEnd(2, "0");
      const minorUnits = (Number(match[2]) * 100 + Number(fraction)) * (match[1] === "-" ? -1 : 1);
      if (!Number.isSafeInteger(minorUnits)) throw new Error("Money value exceeds safe integer range");
      return {
        currency: type.currency,
        amount: `${match[1] ?? ""}${match[2]}.${fraction}`,
        minorUnits,
      };
    }
    case "object":
    case "array":
      throw new Error(`Structured ${type.kind} values require structured extraction`);
  }
}
