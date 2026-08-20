import type { Frame, Locator } from "playwright";
import type {
  ActionV2,
  CapabilityArtifactV2,
  ConditionV2,
  LocatorStrategyV2,
  TargetV2,
  TypeSpecV2,
  ValueExprV2,
} from "../../domain/index.js";
import {
  parseRuntimeValue,
  type ReplayRuntimeV2,
  type RuntimeActionResultV2,
  type RuntimeConditionResultV2,
  type RuntimeContextV2,
  type RuntimePageStateV2,
  type RuntimeResolutionAttemptV2,
  type RuntimeValue,
} from "../replayRuntimeV2.js";
import type { PlaywrightSurface } from "./playwrightSurface.js";

interface ResolvedTargetV2 {
  target: TargetV2;
  locator: Locator;
  strategy: LocatorStrategyV2;
  attempts: RuntimeResolutionAttemptV2[];
}

export class TargetResolutionV2Error extends Error {
  readonly code: "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "FRAME_NOT_FOUND";
  readonly targetId: string;
  readonly attempts: RuntimeResolutionAttemptV2[];

  constructor(
    code: TargetResolutionV2Error["code"],
    targetId: string,
    message: string,
    attempts: RuntimeResolutionAttemptV2[] = [],
  ) {
    super(message);
    this.name = "TargetResolutionV2Error";
    this.code = code;
    this.targetId = targetId;
    this.attempts = attempts;
  }
}

function now(): string {
  return new Date().toISOString();
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function cssString(value: string): string {
  return value.replace(/[\0-\x1f\x7f"\\]/gu, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\${code.toString(16)} `;
  });
}

function scalarText(value: RuntimeValue): string {
  if (value === null) return "";
  if (typeof value === "object") {
    if (!Array.isArray(value) && typeof value.amount === "string") return value.amount;
    throw new Error("A structured value cannot be used as control text");
  }
  return String(value);
}

export class PlaywrightReplayRuntimeV2 implements ReplayRuntimeV2 {
  readonly #surface: PlaywrightSurface;
  readonly #targets: ReadonlyMap<string, TargetV2>;

  constructor(surface: PlaywrightSurface, artifact: Pick<CapabilityArtifactV2, "targets">) {
    this.#surface = surface;
    this.#targets = new Map(artifact.targets.map((target) => [target.id, target]));
  }

  get sessionId(): string {
    return this.#surface.sessionId;
  }

  get sessionRef(): string {
    return this.#surface.sessionRef;
  }

  getTarget(id: string): TargetV2 {
    const target = this.#targets.get(id);
    if (!target) throw new Error(`Unknown V2 target ${id}`);
    return target;
  }

  resolveValue(expression: ValueExprV2, context: RuntimeContextV2): RuntimeValue {
    if (expression.kind === "literal") return expression.value;
    const source = expression.kind === "input" ? context.inputs : context.bindings;
    if (!Object.hasOwn(source, expression.name)) {
      throw new Error(`${expression.kind} ${expression.name} is not available`);
    }
    return source[expression.name]!;
  }

  async act(action: ActionV2, context: RuntimeContextV2): Promise<RuntimeActionResultV2> {
    const startedAt = now();
    if (action.kind === "press") {
      await this.#surface.page.keyboard.press(action.key);
      return { startedAt, completedAt: now(), attempts: [] };
    }

    const resolved = await this.#resolve(action.targetId, context);
    let value: RuntimeValue | undefined;
    switch (action.kind) {
      case "click":
        await resolved.locator.click();
        break;
      case "fill":
        await resolved.locator.fill(scalarText(this.resolveValue(action.value, context)));
        break;
      case "select": {
        const expected = scalarText(this.resolveValue(action.value, context));
        const options = await resolved.locator.locator("option").evaluateAll((nodes) =>
          nodes.map((node) => ({
            value: (node as HTMLOptionElement).value,
            label: (node as HTMLOptionElement).label,
          })),
        );
        const labels = options.filter((item) => item.label === expected);
        const values = options.filter((item) => item.value === expected);
        if (values.length === 1) await resolved.locator.selectOption({ value: expected });
        else if (labels.length === 1) await resolved.locator.selectOption({ label: expected });
        else throw new Error(`Select input ${JSON.stringify(expected)} did not match exactly one option`);
        break;
      }
      case "extract": {
        const raw = action.source === "value"
          ? await resolved.locator.inputValue()
          : await resolved.locator.innerText().catch(async () => resolved.locator.inputValue());
        value = normalize(raw);
        if (action.outputName) context.bindings[`output:${action.outputName}`] = value;
        if (action.bindingName) context.bindings[action.bindingName] = value;
        break;
      }
      case "extract_table": {
        value = await this.#extractTable(resolved.locator, action.columns);
        context.bindings[`output:${action.outputName}`] = value;
        break;
      }
    }
    await this.#surface.waitUntilReady();
    return {
      startedAt,
      completedAt: now(),
      targetId: action.targetId,
      ...(action.kind === "extract" && action.outputName ? { outputName: action.outputName } : {}),
      ...(action.kind === "extract" && action.bindingName ? { bindingName: action.bindingName } : {}),
      ...(action.kind === "extract_table" ? { outputName: action.outputName } : {}),
      ...(value === undefined ? {} : { value }),
      strategy: resolved.strategy.kind,
      attempts: resolved.attempts,
    };
  }

  async evaluate(
    condition: ConditionV2,
    context: RuntimeContextV2,
  ): Promise<RuntimeConditionResultV2> {
    if (condition.kind === "all" || condition.kind === "any") {
      const results = [];
      for (const child of condition.conditions) results.push(await this.evaluate(child, context));
      const matched = condition.kind === "all"
        ? results.every((result) => result.matched)
        : results.some((result) => result.matched);
      return {
        matched,
        summary: `${condition.kind} condition matched=${matched}; ${results.map((item) => item.summary).join("; ")}`,
      };
    }
    if (condition.kind === "not") {
      const result = await this.evaluate(condition.condition, context);
      return { matched: !result.matched, summary: `not(${result.summary})` };
    }
    if (condition.kind === "http_status") {
      const state = await this.pageState();
      return {
        matched: state.httpStatus === condition.status,
        summary: `HTTP status ${state.httpStatus ?? "unknown"}; expected ${condition.status}`,
      };
    }
    if (condition.kind === "page_title") {
      const title = await this.#surface.page.title();
      const matched = condition.exact ? title === condition.title : title.includes(condition.title);
      return { matched, summary: `Page title matched=${matched}` };
    }
    if (condition.kind === "route") {
      const url = new URL(this.#surface.page.url());
      let matched = false;
      try {
        matched = new RegExp(condition.pattern, "u").test(url.pathname);
      } catch {
        return { matched: false, summary: "Route condition contains an invalid expression" };
      }
      return { matched, summary: `Route ${url.pathname} matched declared pattern=${matched}` };
    }
    if (condition.kind === "text_visible") {
      let count = 0;
      for (const frame of this.#surface.page.frames()) {
        const candidates = frame.getByText(condition.text, { exact: condition.exact });
        for (let index = 0; index < await candidates.count(); index += 1) {
          if (await candidates.nth(index).isVisible().catch(() => false)) count += 1;
        }
      }
      return { matched: count > 0, summary: `Visible text marker matched ${count} element(s)` };
    }
    if (
      condition.kind !== "target_present" &&
      condition.kind !== "target_visible" &&
      condition.kind !== "target_value"
    ) {
      return { matched: false, summary: `Unsupported condition kind: ${condition.kind}` };
    }
    try {
      const resolved = await this.#resolve(condition.targetId, context);
      if (condition.kind === "target_present") {
        return { matched: condition.present, summary: `Target ${condition.targetId} is present` };
      }
      if (condition.kind === "target_visible") {
        const visible = await resolved.locator.isVisible();
        return {
          matched: visible === condition.visible,
          summary: `Target ${condition.targetId} visible=${visible}; expected=${condition.visible}`,
        };
      }
      const actual = normalize(
        await resolved.locator.inputValue().catch(async () => resolved.locator.innerText()),
      );
      const expected = scalarText(this.resolveValue(condition.value, context));
      const matched = condition.operator === "equals"
        ? actual === expected
        : condition.operator === "contains"
          ? actual.includes(expected)
          : new RegExp(expected, "u").test(actual);
      return {
        matched,
        summary: condition.redactActual
          ? `Target ${condition.targetId} value ${condition.operator} expected value: ${matched}`
          : `Target ${condition.targetId} observed=${JSON.stringify(actual)} matched=${matched}`,
      };
    } catch (error) {
      if (
        error instanceof TargetResolutionV2Error &&
        error.code === "TARGET_NOT_FOUND" &&
        ((condition.kind === "target_present" && !condition.present) ||
          (condition.kind === "target_visible" && !condition.visible))
      ) {
        return { matched: true, summary: `Target ${condition.targetId} is absent as expected` };
      }
      return { matched: false, summary: error instanceof Error ? error.message : String(error) };
    }
  }

  async waitFor(
    condition: ConditionV2,
    context: RuntimeContextV2,
    timeoutMs: number,
  ): Promise<RuntimeConditionResultV2> {
    const deadline = Date.now() + timeoutMs;
    let result = await this.evaluate(condition, context);
    while (!result.matched && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      result = await this.evaluate(condition, context);
    }
    return result;
  }

  async pageState(): Promise<RuntimePageStateV2> {
    const status = (this.#surface as PlaywrightSurface & { readonly lastMainDocumentStatus?: number | null })
      .lastMainDocumentStatus;
    const method = (this.#surface as PlaywrightSurface & { readonly lastMainDocumentMethod?: "GET" | "POST" | null })
      .lastMainDocumentMethod;
    return {
      url: this.#surface.page.url(),
      title: await this.#surface.page.title(),
      httpStatus: status ?? null,
      method: method ?? null,
    };
  }

  captureMaskedScreenshot(): Promise<Buffer> {
    return this.#surface.captureMaskedScreenshot();
  }

  sanitizedDomSnapshot(): Promise<string> {
    return this.#surface.domSnapshot();
  }

  close(): Promise<void> {
    return this.#surface.close();
  }

  async #resolve(targetId: string, context: RuntimeContextV2): Promise<ResolvedTargetV2> {
    const target = this.getTarget(targetId);
    const root = await this.#frameRoot(target);
    const attempts: RuntimeResolutionAttemptV2[] = [];
    for (const strategy of target.strategies) {
      const candidates = await this.#locators(root, strategy, context);
      const count = candidates.length;
      attempts.push({ strategy: strategy.kind, count, summary: `${strategy.kind} resolved ${count}` });
      if (count === 1) return { target, locator: candidates[0]!, strategy, attempts };
      if (count > 1) {
        throw new TargetResolutionV2Error(
          "TARGET_AMBIGUOUS",
          targetId,
          `Strategy ${strategy.kind} for ${targetId} matched ${count} targets`,
          attempts,
        );
      }
    }
    throw new TargetResolutionV2Error(
      "TARGET_NOT_FOUND",
      targetId,
      `No reviewed V2 strategy found target ${targetId}`,
      attempts,
    );
  }

  async #frameRoot(target: TargetV2): Promise<Frame> {
    let root = this.#surface.page.mainFrame();
    for (const segment of target.framePath) {
      const matches: Frame[] = [];
      for (const child of root.childFrames()) {
        const element = await child.frameElement();
        const title = (await element.getAttribute("title")) ??
          (await element.getAttribute("aria-label")) ??
          (await element.getAttribute("name"));
        if (title === segment.title) matches.push(child);
      }
      if (matches.length !== 1) {
        throw new TargetResolutionV2Error(
          "FRAME_NOT_FOUND",
          target.id,
          `Frame ${JSON.stringify(segment.title)} resolved ${matches.length}; expected one`,
        );
      }
      root = matches[0]!;
    }
    return root;
  }

  async #locators(
    root: Frame,
    strategy: LocatorStrategyV2,
    context: RuntimeContextV2,
  ): Promise<Locator[]> {
    if (strategy.kind === "role") {
      return this.#visibleOrPresent(root.getByRole(strategy.role as never, { name: strategy.name, exact: strategy.exact }));
    }
    if (strategy.kind === "label") {
      return this.#visibleOrPresent(root.getByLabel(strategy.label, { exact: strategy.exact }));
    }
    if (strategy.kind === "name") {
      return this.#visibleOrPresent(root.locator(`[name="${cssString(strategy.name)}"]`));
    }
    if (strategy.kind === "text") {
      return this.#visibleOrPresent(root.getByText(strategy.text, { exact: strategy.exact }));
    }
    if (strategy.kind === "label_value") {
      const matches: Locator[] = [];
      const rows = root.locator("tr");
      for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
        const cells = rows.nth(rowIndex).locator(":scope > th, :scope > td");
        const texts = (await cells.allInnerTexts()).map(normalize);
        for (let cellIndex = 0; cellIndex < texts.length; cellIndex += 1) {
          if (texts[cellIndex] === strategy.label) {
            const valueIndex = cellIndex + strategy.valueCellOffset;
            if (valueIndex < texts.length) matches.push(cells.nth(valueIndex));
          }
        }
      }
      return matches;
    }
    const tables = await this.#matchingTables(
      root,
      strategy.headers,
      strategy.kind === "table" ? strategy.nearText : undefined,
    );
    if (strategy.kind === "table") return tables;

    const expectedKey = scalarText(this.resolveValue(strategy.key, context));
    const controls: Locator[] = [];
    for (const table of tables) {
        const headerMap = await this.#headerMap(table, strategy.headers);
      const keyIndex = headerMap.get(strategy.keyColumn);
      if (keyIndex === undefined) continue;
      const rows = table.locator("tr");
      for (let rowIndex = 1; rowIndex < await rows.count(); rowIndex += 1) {
        const row = rows.nth(rowIndex);
        const cells = row.locator(":scope > th, :scope > td");
        if (keyIndex >= await cells.count()) continue;
        if (normalize(await cells.nth(keyIndex).innerText()) !== expectedKey) continue;
        const candidate = row.getByRole(strategy.controlRole as never, {
          name: strategy.controlName,
          exact: true,
        });
        for (let controlIndex = 0; controlIndex < await candidate.count(); controlIndex += 1) {
          controls.push(candidate.nth(controlIndex));
        }
      }
    }
    return controls;
  }

  async #visibleOrPresent(locator: Locator): Promise<Locator[]> {
    const result: Locator[] = [];
    for (let index = 0; index < await locator.count(); index += 1) result.push(locator.nth(index));
    return result;
  }

  async #matchingTables(root: Frame, headers: string[], nearText?: string): Promise<Locator[]> {
    const matches: Locator[] = [];
    const tables = root.locator("table");
    for (let index = 0; index < await tables.count(); index += 1) {
      const table = tables.nth(index);
      const map = await this.#headerMap(table, headers);
      if (!headers.every((header) => map.has(header))) continue;
      if (nearText) {
        const parentText = normalize(await table.locator("xpath=..").innerText().catch(() => ""));
        if (!parentText.includes(nearText)) continue;
      }
      matches.push(table);
    }
    return matches;
  }

  async #headerMap(table: Locator, requiredHeaders: readonly string[] = []): Promise<Map<string, number>> {
    const rows = table.locator("tr");
    if (await rows.count() === 0) return new Map();
    const texts = (await rows.first().locator(":scope > th, :scope > td").allInnerTexts()).map(normalize);
    const headers = new Map<string, number>();
    for (const [index, text] of texts.entries()) {
      if (!text) continue;
      if (headers.has(text)) {
        if (requiredHeaders.includes(text)) throw new Error(`Table contains duplicate header ${JSON.stringify(text)}`);
        continue;
      }
      headers.set(text, index);
    }
    return headers;
  }

  async #extractTable(
    table: Locator,
    columns: Array<{ header: string; key: string; type: TypeSpecV2 }>,
  ): Promise<RuntimeValue> {
    const headerMap = await this.#headerMap(table, columns.map((column) => column.header));
    for (const column of columns) {
      if (!headerMap.has(column.header)) throw new Error(`Table is missing header ${column.header}`);
    }
    const output: RuntimeValue[] = [];
    const rows = table.locator("tr");
    for (let rowIndex = 1; rowIndex < await rows.count(); rowIndex += 1) {
      const cells = rows.nth(rowIndex).locator(":scope > th, :scope > td");
      if (await cells.count() === 0) continue;
      const item: { [key: string]: RuntimeValue } = Object.create(null) as { [key: string]: RuntimeValue };
      for (const column of columns) {
        const cellIndex = headerMap.get(column.header)!;
        if (cellIndex >= await cells.count()) throw new Error(`Table row is missing ${column.header}`);
        item[column.key] = parseRuntimeValue(column.type, await cells.nth(cellIndex).innerText());
      }
      output.push(item);
    }
    return output;
  }
}
