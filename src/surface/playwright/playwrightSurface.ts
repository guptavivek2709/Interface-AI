import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import type { PlannerAction } from "../../model/planner.js";
import type {
  ActionReceipt,
  FrameScopeObservation,
  ObservedControl,
  ObservedFrame,
  ObservedSemanticTarget,
  SurfaceObservation,
} from "../types.js";

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  observationDirectory: string;
  timeoutMs?: number;
  onNavigation?: (url: string) => void;
  onPopup?: (url: string) => void;
  onDownload?: (suggestedFilename: string) => void;
  assertNavigationAllowed?: (url: string, kind: "direct" | "redirect" | "popup" | "frame") => void;
  /** Evaluated for every HTTP(S) request, not only navigations. */
  assertResourceAllowed?: (url: string) => void;
  /** Trusted adapter selectors for legacy regions containing restricted member/financial data. */
  sensitiveSelectors?: readonly string[];
  /** Mutates a detached URL only for observations/evidence; never for navigation. */
  redactObservedUrl?: (url: URL) => void;
}

type LocatorRoot = Frame | Page;

interface RawControl {
  role: ObservedControl["role"];
  name: string;
  tag: string;
  label: string | null;
  nameAttribute: string | null;
  text: string | null;
  value: string | null;
  disabled: boolean;
}

type SemanticTargetWithoutRef<T = ObservedSemanticTarget> = T extends ObservedSemanticTarget
  ? Omit<T, "ref">
  : never;

interface SemanticCandidate {
  readonly identity: string;
  readonly target: SemanticTargetWithoutRef;
}

function normalizeText(input: string | null | undefined): string {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

function sanitizeUrl(raw: string, redact?: (url: URL) => void): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    try {
      redact?.(url);
    } catch {
      return url.origin;
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export class PlaywrightSurface {
  readonly sessionId = randomUUID();
  readonly sessionRef = createHash("sha256").update(this.sessionId).digest("hex");
  readonly #options: Required<Pick<PlaywrightSurfaceOptions, "headless" | "timeoutMs">> &
    PlaywrightSurfaceOptions;
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #mainDocumentHttpStatus: number | null = null;
  #mainDocumentMethod: "GET" | "POST" | null = null;
  #observationSequence = 0;

  constructor(options: PlaywrightSurfaceOptions) {
    this.#options = {
      ...options,
      headless: options.headless ?? true,
      timeoutMs: options.timeoutMs ?? 8_000,
    };
  }

  get page(): Page {
    if (!this.#page) throw new Error("Surface has not been started");
    return this.#page;
  }

  get context(): BrowserContext {
    if (!this.#context) throw new Error("Surface has not been started");
    return this.#context;
  }

  /** Latest main-frame document response status; subframes and assets are ignored. */
  get lastMainDocumentStatus(): number | null {
    return this.#mainDocumentHttpStatus;
  }

  /** Method of the latest main-frame document request. */
  get lastMainDocumentMethod(): "GET" | "POST" | null {
    return this.#mainDocumentMethod;
  }

  async start(entrypoint: string): Promise<void> {
    await mkdir(this.#options.observationDirectory, { recursive: true });
    this.#options.assertNavigationAllowed?.(entrypoint, "direct");
    this.#mainDocumentHttpStatus = null;
    this.#mainDocumentMethod = null;
    this.#browser = await chromium.launch({ headless: this.#options.headless });
    this.#context = await this.#browser.newContext({
      viewport: { width: 1365, height: 900 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await this.#context.route("**/*", async (route) => {
      const request = route.request();
      try {
        const protocol = new URL(request.url()).protocol;
        if (protocol === "http:" || protocol === "https:") {
          this.#options.assertResourceAllowed?.(request.url());
        }
        if (request.isNavigationRequest()) {
          const frame = request.frame();
          const kind = frame === this.#page?.mainFrame() ? "direct" : "frame";
          this.#options.assertNavigationAllowed?.(request.url(), kind);
        }
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await this.#context.routeWebSocket(/.*/u, async (webSocket) => {
      try {
        this.#options.assertResourceAllowed?.(webSocket.url());
        webSocket.connectToServer();
      } catch {
        await webSocket.close({ code: 1008, reason: "Blocked by resource policy" });
      }
    });
    this.#page = await this.#context.newPage();
    this.#page.setDefaultTimeout(this.#options.timeoutMs);
    this.#page.on("response", (response) => {
      const request = response.request();
      if (!request.isNavigationRequest() || request.resourceType() !== "document") return;
      try {
        if (request.frame() === this.#page?.mainFrame()) {
          this.#mainDocumentHttpStatus = response.status();
          const method = request.method().toUpperCase();
          this.#mainDocumentMethod = method === "GET" || method === "POST" ? method : null;
        }
      } catch {
        // A response can arrive as its frame detaches. It cannot describe the
        // currently active main document, so retain the last known main status.
      }
    });
    this.#page.on("framenavigated", (frame) => this.#options.onNavigation?.(frame.url()));
    this.#page.on("popup", (popup) => {
      const url = popup.url();
      try {
        this.#options.assertNavigationAllowed?.(url, "popup");
      } catch {
        // The context route guard independently blocks the popup navigation.
        // Event-listener exceptions must not escape as unhandled rejections;
        // closing the page is the final fail-closed boundary.
      } finally {
        try {
          this.#options.onPopup?.(url);
        } finally {
          void popup.close().catch(() => undefined);
        }
      }
    });
    this.#page.on("download", (download) => {
      this.#options.onDownload?.(download.suggestedFilename());
      void download.cancel();
    });
    await this.#page.goto(entrypoint, { waitUntil: "domcontentloaded" });
    await this.waitUntilReady();
  }

  async close(): Promise<void> {
    await this.#context?.close().catch(() => undefined);
    await this.#browser?.close().catch(() => undefined);
    this.#page = null;
    this.#context = null;
    this.#browser = null;
    this.#mainDocumentHttpStatus = null;
    this.#mainDocumentMethod = null;
  }

  async waitUntilReady(timeoutMs = this.#options.timeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let busy = 0;
      for (const frame of this.page.frames()) {
        try {
          busy += await frame.locator('[aria-busy="true"]:visible').count();
        } catch {
          busy += 1;
        }
      }
      if (busy === 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Surface remained aria-busy for more than ${timeoutMs}ms`);
  }

  async observe(
    inputs: Readonly<Record<string, string | number | boolean>> = {},
  ): Promise<SurfaceObservation> {
    await this.waitUntilReady();
    const frames: ObservedFrame[] = [];
    const controls: ObservedControl[] = [];
    const semanticCandidates: SemanticCandidate[] = [];
    let sequence = 0;

    for (const frame of this.page.frames()) {
      const framePath = await this.#framePath(frame);
      let visibleText = "";
      let title = "";
      let headings: string[] = [];
      try {
        visibleText = normalizeText(await frame.locator("body").innerText({ timeout: 2_000 }));
        title = await frame.title();
        headings = (await frame.locator("h1,h2,h3,[role=heading]").allInnerTexts())
          .map(normalizeText)
          .filter(Boolean);
      } catch {
        // A frame can detach while another frame navigates. The next observation will include it.
      }
      frames.push({
        framePath,
        url: sanitizeUrl(frame.url(), this.#options.redactObservedUrl),
        title,
        headings,
        visibleText: visibleText.slice(0, 4_000),
      });

      const locator = frame.locator(
        'button,input,select,textarea,a[href],output,[role="button"],[role="link"],[role="status"]',
      );
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        const raw = await this.#describeControl(item).catch(() => null);
        if (!raw || !raw.name) continue;
        sequence += 1;
        controls.push({ ref: `c${sequence}`, framePath, ...raw });
      }
      semanticCandidates.push(...(await this.#observeSemanticTargets(frame, framePath, inputs)));
    }

    const semanticIdentityCounts = new Map<string, number>();
    for (const candidate of semanticCandidates) {
      semanticIdentityCounts.set(
        candidate.identity,
        (semanticIdentityCounts.get(candidate.identity) ?? 0) + 1,
      );
    }
    const semanticTargets = semanticCandidates
      .filter((candidate) => semanticIdentityCounts.get(candidate.identity) === 1)
      .map((candidate, index): ObservedSemanticTarget => ({
        ref: `s${index + 1}`,
        ...candidate.target,
      } as ObservedSemanticTarget));

    const screenshotPath = path.join(
      this.#options.observationDirectory,
      `observation-${String(++this.#observationSequence).padStart(3, "0")}.png`,
    );
    const masks = this.#sensitiveMasks();
    await this.page.screenshot({
      path: screenshotPath,
      fullPage: false,
      mask: masks,
      maskColor: "#111111",
      animations: "disabled",
      caret: "hide",
    });
    const canonical = JSON.stringify({
      url: sanitizeUrl(this.page.url(), this.#options.redactObservedUrl),
      httpStatus: this.#mainDocumentHttpStatus,
      frames: frames.map(({ framePath, url, headings, visibleText }) => ({
        framePath,
        url,
        headings,
        visibleText,
      })),
      controls: controls.map(({ ref: _ref, ...control }) => control),
      semanticTargets: semanticTargets.map(({ ref: _ref, ...target }) => target),
    });
    return {
      capturedAt: new Date().toISOString(),
      url: sanitizeUrl(this.page.url(), this.#options.redactObservedUrl),
      title: await this.page.title(),
      httpStatus: this.#mainDocumentHttpStatus,
      controls,
      semanticTargets,
      frames,
      visibleText: frames.map((frame) => frame.visibleText).join("\n").slice(0, 10_000),
      stateHash: createHash("sha256").update(canonical).digest("hex"),
      screenshotPath,
    };
  }

  async actFromObservation(
    action: PlannerAction,
    observation: SurfaceObservation,
    inputs: Record<string, string | number | boolean>,
  ): Promise<ActionReceipt> {
    const startedAt = new Date().toISOString();
    if (action.kind === "press") {
      await this.page.keyboard.press(action.key ?? "");
      return { startedAt, completedAt: new Date().toISOString() };
    }
    const control = observation.controls.find((candidate) => candidate.ref === action.targetRef);
    const semanticTarget = observation.semanticTargets?.find(
      (candidate) => candidate.ref === action.targetRef,
    );
    if (!control && !semanticTarget) {
      throw new Error(`Observed target ${action.targetRef ?? "<missing>"} does not exist`);
    }
    const locator = control
      ? await this.#resolveObservedControl(control)
      : await this.#resolveObservedSemanticTarget(semanticTarget!, inputs);
    const value = action.value ? this.#resolvePlannerValue(action.value, inputs) : undefined;
    let observedValue: string | undefined;
    switch (action.kind) {
      case "click":
        if (semanticTarget && semanticTarget.kind !== "table_row_control") {
          throw new Error(`Cannot click semantic ${semanticTarget.kind} target`);
        }
        await locator.click();
        break;
      case "fill":
        if (semanticTarget) throw new Error(`Cannot fill semantic ${semanticTarget.kind} target`);
        await locator.fill(String(value ?? ""));
        break;
      case "select": {
        if (semanticTarget) throw new Error(`Cannot select semantic ${semanticTarget.kind} target`);
        const exactValue = String(value ?? "");
        const options = await locator.locator("option").evaluateAll((elements) =>
          elements.map((element) => ({
            value: (element as HTMLOptionElement).value,
            label: (element as HTMLOptionElement).label,
          })),
        );
        const labelMatches = options.filter((option) => option.label === exactValue);
        const valueMatches = options.filter((option) => option.value === exactValue);
        if (labelMatches.length === 1) await locator.selectOption({ label: exactValue });
        else if (valueMatches.length === 1) await locator.selectOption({ value: exactValue });
        else {
          throw new Error(
            `Select value ${JSON.stringify(exactValue)} did not match exactly one option`,
          );
        }
        break;
      }
      case "extract":
        if (semanticTarget?.kind === "table_row_control") {
          throw new Error("Cannot extract a table row control");
        }
        observedValue =
          semanticTarget?.kind === "table"
            ? JSON.stringify(await this.#extractObservedTable(locator, semanticTarget.headers))
            : normalizeText(await locator.innerText().catch(async () => locator.inputValue()));
        break;
    }
    await this.waitUntilReady();
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      targetRef: (control ?? semanticTarget)!.ref,
      ...(observedValue === undefined ? {} : { observedValue }),
    };
  }

  async humanClick(accessibleName: string): Promise<ActionReceipt> {
    const startedAt = new Date().toISOString();
    const matches: Locator[] = [];
    for (const frame of this.page.frames()) {
      const candidate = frame.getByRole("button", { name: accessibleName, exact: true });
      if ((await candidate.count()) > 0) matches.push(candidate);
    }
    const total = (
      await Promise.all(matches.map(async (match) => match.count()))
    ).reduce((sum, count) => sum + count, 0);
    if (total !== 1 || matches.length !== 1) {
      throw new Error(`Human target ${JSON.stringify(accessibleName)} resolved to ${total} controls`);
    }
    await matches[0]!.click();
    await this.waitUntilReady();
    return { startedAt, completedAt: new Date().toISOString() };
  }

  async captureMaskedScreenshot(): Promise<Buffer> {
    const masks = this.#sensitiveMasks();
    return this.page.screenshot({
      fullPage: false,
      mask: masks,
      maskColor: "#111111",
      animations: "disabled",
      caret: "hide",
      type: "png",
    });
  }

  async domSnapshot(): Promise<string> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: Math.min(this.#options.timeoutMs, 2_000) }).catch(() => undefined);
    const documents: string[] = [];
    const initialMainFrame = this.page.mainFrame();
    for (const initialFrame of this.page.frames()) {
      let frame = initialFrame;
      const framePath = await this.#framePath(frame).catch(() => []);
      const label = framePath.map((segment) => segment.title).join(" > ") || "top";
      let html: string | undefined;
      let lastError: unknown;
      const mainFrame = initialFrame === initialMainFrame;
      for (let attempt = 0; attempt < (mainFrame ? 3 : 2); attempt += 1) {
        if (mainFrame) frame = this.page.mainFrame();
        try {
          await frame.locator("html").waitFor({ state: "attached", timeout: Math.min(this.#options.timeoutMs, 1_500) });
          html = await this.#sanitizedFrameHtml(frame);
          break;
        } catch (error) {
          lastError = error;
          if (!mainFrame && frame.isDetached()) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
      if (mainFrame && html === undefined && lastError) throw lastError;
      html ??= "<!-- detached frame -->";
      documents.push(`<!-- frame: ${label}; url: ${sanitizeUrl(frame.url(), this.#options.redactObservedUrl)} -->\n${html}`);
    }
    return documents.join("\n\n");
  }

  async #sanitizedFrameHtml(frame: Frame): Promise<string> {
    return frame.locator("html").evaluate((root, configuredSelectors) => {
      const clone = root.cloneNode(true) as HTMLElement;
      for (const active of clone.querySelectorAll(
        "script,iframe,object,embed,base,link[rel='stylesheet'],meta[http-equiv]",
      )) {
        active.remove();
      }
      for (const element of clone.querySelectorAll("*")) {
        for (const attribute of [...element.attributes]) {
          const name = attribute.name.toLowerCase();
          if (name.startsWith("on") || name === "srcdoc") element.removeAttribute(attribute.name);
          else if (["href", "src", "action", "formaction"].includes(name)) {
            element.setAttribute(attribute.name, "#");
          }
        }
      }
      const selectors = [
        'input:not([type="hidden"])',
        "textarea",
        "select",
        '[contenteditable="true"]',
        "[data-sensitive]",
        "output",
        ...configuredSelectors,
      ];
      // Keep this logic inline. The guarded demo command runs through tsx,
      // whose keep-names transform can otherwise inject a Node-side __name
      // helper into a nested callback that Playwright evaluates in-browser.
      for (const element of clone.querySelectorAll(selectors.join(","))) {
        if (element instanceof HTMLInputElement) {
          element.value = "[REDACTED]";
          element.setAttribute("value", "[REDACTED]");
        } else if (element instanceof HTMLTextAreaElement) {
          element.value = "[REDACTED]";
          element.textContent = "[REDACTED]";
        } else if (element instanceof HTMLSelectElement) {
          for (const option of element.options) option.removeAttribute("selected");
        } else {
          element.textContent = "[REDACTED]";
        }
      }
      return `<!doctype html>\n${clone.outerHTML}`;
    }, this.#options.sensitiveSelectors ?? []);
  }

  async #observeSemanticTargets(
    frame: Frame,
    framePath: FrameScopeObservation[],
    inputs: Readonly<Record<string, string | number | boolean>>,
  ): Promise<SemanticCandidate[]> {
    const result: SemanticCandidate[] = [];
    const inputNamesByValue = new Map<string, string[]>();
    for (const [name, value] of Object.entries(inputs)) {
      const text = String(value);
      const names = inputNamesByValue.get(text) ?? [];
      names.push(name);
      inputNamesByValue.set(text, names);
    }
    const frameIdentity = framePath.map(({ title }) => title);
    const tables = frame.locator("table");
    const tableCount = await tables.count().catch(() => 0);
    for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
      const table = tables.nth(tableIndex);
      if (!(await table.isVisible().catch(() => false))) continue;
      // Direct rows only: period-accurate layouts nest data tables inside
      // presentation tables. Descendant traversal would observe the same row
      // once per ancestor table and incorrectly discard it as ambiguous.
      const rows = table.locator(
        ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr",
      );
      const rowCount = await rows.count().catch(() => 0);
      const rowCells: Array<Array<{ tag: string; text: string; className: string }>> = [];
      let headerRowIndex = -1;
      let headers: string[] = [];
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const cells = rows.nth(rowIndex).locator(":scope > th, :scope > td");
        const described = await cells
          .evaluateAll((elements) =>
            elements.map((element) => ({
              tag: element.tagName.toLowerCase(),
              text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
              className: element.getAttribute("class") ?? "",
            })),
          )
          .catch(() => []);
        rowCells.push(described);
        const rowPresentation = await rows
          .nth(rowIndex)
          .evaluate((element) => ({
            className: element.getAttribute("class") ?? "",
            background: element.getAttribute("bgcolor") ?? "",
          }))
          .catch(() => ({ className: "", background: "" }));
        const firstBlankHeader = described.findIndex((cell) => !cell.text);
        const namedHeaderCells = firstBlankHeader === -1
          ? described
          : described.slice(0, firstBlankHeader);
        const onlyTrailingBlankHeaders =
          firstBlankHeader === -1 ||
          described.slice(firstBlankHeader).every((cell) => !cell.text);
        if (
          headerRowIndex === -1 &&
          namedHeaderCells.length >= 2 &&
          onlyTrailingBlankHeaders &&
          (described.every((cell) => cell.tag === "th") ||
            /(?:^|\s)lbl(?:\s|$)/u.test(rowPresentation.className) ||
            Boolean(rowPresentation.background))
        ) {
          headerRowIndex = rowIndex;
          headers = namedHeaderCells.map((cell) => cell.text);
        }

        for (let cellIndex = 0; cellIndex + 1 < described.length; cellIndex += 1) {
          const labelCell = described[cellIndex]!;
          const valueCell = described[cellIndex + 1]!;
          const labelStyled =
            labelCell.tag === "th" || /(?:^|\s)lbl(?:\s|$)/u.test(labelCell.className);
          if (!labelStyled || !labelCell.text || !valueCell.text) continue;
          const valueCellHasInteractiveControl =
            (await cells
              .nth(cellIndex + 1)
              .locator('input,select,textarea,button,a[href],[contenteditable="true"]')
              .count()
              .catch(() => 1)) > 0;
          if (valueCellHasInteractiveControl) continue;
          const label = labelCell.text;
          result.push({
            identity: JSON.stringify([frameIdentity, "label_value", label, 1]),
            target: {
              kind: "label_value",
              framePath,
              name: `${label} value`,
              label,
              valueCellOffset: 1,
            },
          });
        }
      }

      const hasUniqueHeaders =
        headers.length >= 2 && new Set(headers).size === headers.length;
      if (!hasUniqueHeaders) continue;
      result.push({
        identity: JSON.stringify([frameIdentity, "table", headers]),
        target: {
          kind: "table",
          framePath,
          name: `Table: ${headers.join(", ")}`,
          headers,
        },
      });

      for (let rowIndex = headerRowIndex + 1; rowIndex < rowCells.length; rowIndex += 1) {
        const cells = rowCells[rowIndex] ?? [];
        if (cells.length === 0) continue;
        for (let cellIndex = 0; cellIndex < Math.min(cells.length, headers.length); cellIndex += 1) {
          const keyText = cells[cellIndex]?.text ?? "";
          const inputNames = inputNamesByValue.get(keyText);
          if (inputNames?.length !== 1) continue;
          const row = rows.nth(rowIndex);
          for (let valueIndex = 0; valueIndex < Math.min(cells.length, headers.length); valueIndex += 1) {
            if (valueIndex === cellIndex || !cells[valueIndex]?.text) continue;
            const target: SemanticTargetWithoutRef = {
              kind: "table_row_value",
              framePath,
              name: `${headers[valueIndex]} for ${inputNames[0]}`,
              headers,
              keyColumn: headers[cellIndex]!,
              keyInputName: inputNames[0]!,
              valueColumn: headers[valueIndex]!,
            };
            result.push({
              identity: JSON.stringify([
                frameIdentity,
                "table_row_value",
                headers,
                target.keyColumn,
                target.keyInputName,
                target.valueColumn,
              ]),
              target,
            });
          }
          const controls = row.locator('button,a[href],[role="button"],[role="link"]');
          const controlCount = await controls.count().catch(() => 0);
          for (let controlIndex = 0; controlIndex < controlCount; controlIndex += 1) {
            const raw = await this.#describeControl(controls.nth(controlIndex)).catch(() => null);
            if (!raw || !raw.name || (raw.role !== "button" && raw.role !== "link")) continue;
            const target: SemanticTargetWithoutRef = {
              kind: "table_row_control",
              framePath,
              name: `${raw.name} for ${headers[cellIndex]}`,
              headers,
              keyColumn: headers[cellIndex]!,
              keyInputName: inputNames[0]!,
              controlRole: raw.role,
              controlName: raw.name,
            };
            result.push({
              identity: JSON.stringify([
                frameIdentity,
                "table_row_control",
                headers,
                target.keyColumn,
                target.keyInputName,
                target.controlRole,
                target.controlName,
              ]),
              target,
            });
          }
        }
      }
    }
    return result;
  }

  async #describeControl(locator: Locator): Promise<RawControl> {
    return locator.evaluate((element) => {
      const html = element as HTMLElement;
      const tag = html.tagName.toLowerCase();
      const input = element as HTMLInputElement;
      const explicitAria = html.getAttribute("aria-label")?.trim() || null;
      const labelledBy = html.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ? labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ") || null
        : null;
      let label: string | null = null;
      if ("labels" in input && input.labels?.length) {
        label = Array.from(input.labels)
          .map((item) => item.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
      }
      const text = (html.innerText || html.textContent || "").replace(/\s+/g, " ").trim() || null;
      const placeholder = input.placeholder?.trim() || null;
      const inputType = tag === "input" ? input.type.toLowerCase() : "";
      const isInputButton = ["submit", "button", "reset", "image"].includes(inputType);
      const buttonValue = isInputButton ? input.value.trim() || null : null;
      const name =
        explicitAria || labelledText || label || buttonValue || text || placeholder || input.name || tag;
      let role = html.getAttribute("role") || "generic";
      if (!html.hasAttribute("role")) {
        if (tag === "button") role = "button";
        else if (tag === "a") role = "link";
        else if (tag === "select") role = "combobox";
        else if (tag === "textarea") role = "textbox";
        else if (tag === "output") role = "status";
        else if (tag === "input") {
          if (isInputButton) role = "button";
          else if (inputType === "checkbox") role = "checkbox";
          else if (inputType === "radio") role = "radio";
          else role = "textbox";
        }
      }
      return {
        role,
        name,
        tag,
        label,
        nameAttribute: html.getAttribute("name"),
        text,
        value:
          tag === "input" && inputType === "password"
            ? null
            : "value" in input
              ? String(input.value ?? "")
              : text,
        disabled:
          ("disabled" in input && Boolean(input.disabled)) || html.getAttribute("aria-disabled") === "true",
      };
    }) as Promise<RawControl>;
  }

  async #framePath(frame: Frame): Promise<FrameScopeObservation[]> {
    const result: FrameScopeObservation[] = [];
    let cursor: Frame | null = frame;
    while (cursor && cursor !== this.page.mainFrame()) {
      const element = await cursor.frameElement();
      result.unshift({
        title:
          (await element.getAttribute("title")) ??
          (await element.getAttribute("aria-label")) ??
          (await element.getAttribute("name")) ??
          "unnamed frame",
        url: sanitizeUrl(cursor.url(), this.#options.redactObservedUrl),
      });
      cursor = cursor.parentFrame();
    }
    return result;
  }

  async #rootForPath(framePath: readonly FrameScopeObservation[]): Promise<LocatorRoot> {
    let current: Frame = this.page.mainFrame();
    for (const frameRef of framePath) {
      const candidates: Frame[] = [];
      for (const child of current.childFrames()) {
        const element = await child.frameElement();
        const title =
          (await element.getAttribute("title")) ??
          (await element.getAttribute("aria-label")) ??
          (await element.getAttribute("name"));
        if (title === frameRef.title) candidates.push(child);
      }
      if (candidates.length !== 1) {
        throw new Error(`Frame ${JSON.stringify(frameRef.title)} resolved to ${candidates.length} frames`);
      }
      current = candidates[0]!;
    }
    return current;
  }

  async #resolveObservedControl(control: ObservedControl): Promise<Locator> {
    const root = await this.#rootForPath(control.framePath);
    const byRole = root.getByRole(control.role as never, { name: control.name, exact: true });
    if ((await byRole.count()) === 1) return byRole;
    if ((await byRole.count()) > 1) {
      throw new Error(`Target ${control.name} is ambiguous by role and name`);
    }
    if (control.label) {
      const byLabel = root.getByLabel(control.label, { exact: true });
      if ((await byLabel.count()) === 1) return byLabel;
      if ((await byLabel.count()) > 1) throw new Error(`Target ${control.name} is ambiguous by label`);
    }
    if (control.nameAttribute) {
      const escaped = control.nameAttribute.replace(/(["\\])/g, "\\$1");
      const byName = root.locator(`[name="${escaped}"]`);
      if ((await byName.count()) === 1) return byName;
      if ((await byName.count()) > 1) throw new Error(`Target ${control.name} is ambiguous by name`);
    }
    throw new Error(`Target ${control.name} could not be resolved uniquely`);
  }

  async #resolveObservedSemanticTarget(
    target: ObservedSemanticTarget,
    inputs: Readonly<Record<string, string | number | boolean>>,
  ): Promise<Locator> {
    const root = await this.#rootForPath(target.framePath);
    if (target.kind === "label_value") {
      const matches: Locator[] = [];
      const rows = root.locator("tr");
      for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
        const cells = rows.nth(rowIndex).locator(":scope > th, :scope > td");
        const texts = (await cells.allInnerTexts()).map(normalizeText);
        for (let cellIndex = 0; cellIndex < texts.length; cellIndex += 1) {
          if (texts[cellIndex] !== target.label) continue;
          const valueIndex = cellIndex + target.valueCellOffset;
          if (valueIndex < texts.length) matches.push(cells.nth(valueIndex));
        }
      }
      if (matches.length !== 1) {
        throw new Error(
          `Semantic label ${JSON.stringify(target.label)} resolved to ${matches.length} values`,
        );
      }
      return matches[0]!;
    }

    const tables = await this.#matchingObservedTables(root, target.headers);
    if (target.kind === "table") {
      if (tables.length !== 1) {
        throw new Error(`Semantic table resolved to ${tables.length} tables`);
      }
      return tables[0]!;
    }
    if (!Object.hasOwn(inputs, target.keyInputName)) {
      throw new Error(`Semantic row target references unknown input ${target.keyInputName}`);
    }
    const expectedKey = String(inputs[target.keyInputName]);
    const matches: Locator[] = [];
    for (const table of tables) {
      const headerMap = await this.#observedTableHeaderMap(table, target.headers);
      const keyIndex = headerMap.get(target.keyColumn);
      if (keyIndex === undefined) continue;
      const rows = table.locator(
        ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr",
      );
      for (let rowIndex = 1; rowIndex < await rows.count(); rowIndex += 1) {
        const row = rows.nth(rowIndex);
        const cells = row.locator(":scope > th, :scope > td");
        if (keyIndex >= await cells.count()) continue;
        if (normalizeText(await cells.nth(keyIndex).innerText()) !== expectedKey) continue;
        if (target.kind === "table_row_value") {
          const valueIndex = headerMap.get(target.valueColumn);
          if (valueIndex !== undefined && valueIndex < await cells.count()) {
            matches.push(cells.nth(valueIndex));
          }
          continue;
        }
        const controls = row.getByRole(target.controlRole as never, {
          name: target.controlName,
          exact: true,
        });
        for (let index = 0; index < await controls.count(); index += 1) {
          matches.push(controls.nth(index));
        }
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        target.kind === "table_row_value"
          ? `Semantic row value ${JSON.stringify(target.valueColumn)} resolved to ${matches.length} cells`
          : `Semantic row control ${JSON.stringify(target.controlName)} resolved to ${matches.length} controls`,
      );
    }
    return matches[0]!;
  }

  async #matchingObservedTables(root: LocatorRoot, headers: readonly string[]): Promise<Locator[]> {
    const matches: Locator[] = [];
    const tables = root.locator("table");
    for (let index = 0; index < await tables.count(); index += 1) {
      const table = tables.nth(index);
      const map = await this.#observedTableHeaderMap(table, headers);
      if (headers.every((header) => map.has(header))) matches.push(table);
    }
    return matches;
  }

  async #observedTableHeaderMap(
    table: Locator,
    expectedHeaders: readonly string[],
  ): Promise<Map<string, number>> {
    const rows = table.locator(
      ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr",
    );
    for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
      const cells = rows.nth(rowIndex).locator(":scope > th, :scope > td");
      const values = await cells.evaluateAll((elements) =>
        elements.map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        })),
      );
      const rowPresentation = await rows
        .nth(rowIndex)
        .evaluate((element) => ({
          className: element.getAttribute("class") ?? "",
          background: element.getAttribute("bgcolor") ?? "",
        }))
        .catch(() => ({ className: "", background: "" }));
      const firstBlankHeader = values.findIndex((value) => !value.text);
      const namedValues = firstBlankHeader === -1 ? values : values.slice(0, firstBlankHeader);
      const onlyTrailingBlankHeaders =
        firstBlankHeader === -1 || values.slice(firstBlankHeader).every((value) => !value.text);
      if (
        namedValues.length < 2 ||
        !onlyTrailingBlankHeaders ||
        !(
          values.every((value) => value.tag === "th") ||
          /(?:^|\s)lbl(?:\s|$)/u.test(rowPresentation.className) ||
          Boolean(rowPresentation.background)
        )
      ) continue;
      const map = new Map<string, number>();
      for (const [index, value] of namedValues.entries()) {
        if (map.has(value.text)) return new Map();
        map.set(value.text, index);
      }
      if (expectedHeaders.every((header) => map.has(header))) return map;
    }
    return new Map();
  }

  async #extractObservedTable(
    table: Locator,
    headers: readonly string[],
  ): Promise<Array<Record<string, string>>> {
    const headerMap = await this.#observedTableHeaderMap(table, headers);
    if (!headers.every((header) => headerMap.has(header))) {
      throw new Error("Observed table headers changed before extraction");
    }
    const rows = table.locator(
      ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr",
    );
    const result: Array<Record<string, string>> = [];
    let passedHeader = false;
    for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
      const cells = rows.nth(rowIndex).locator(":scope > th, :scope > td");
      const texts = (await cells.allInnerTexts()).map(normalizeText);
      if (!passedHeader) {
        passedHeader = headers.every((header) => texts.includes(header));
        continue;
      }
      if (texts.length === 0) continue;
      const record = Object.create(null) as Record<string, string>;
      for (const header of headers) {
        const index = headerMap.get(header)!;
        record[header] = texts[index] ?? "";
      }
      result.push(record);
    }
    return result;
  }

  #resolvePlannerValue(
    expression: NonNullable<PlannerAction["value"]>,
    inputs: Record<string, string | number | boolean>,
  ): string | number | boolean {
    if (expression.kind === "literal") {
      if (expression.value === null) throw new Error("Literal planner value cannot be null");
      return expression.value;
    }
    if (!expression.name || !Object.hasOwn(inputs, expression.name)) {
      throw new Error(`Planner referenced unknown input ${expression.name ?? "<missing>"}`);
    }
    return inputs[expression.name]!;
  }

  #sensitiveMasks(): Locator[] {
    const masks: Locator[] = [];
    for (const frame of this.page.frames()) {
      masks.push(
        frame.locator(
          'input:not([type="hidden"]),textarea,select,[contenteditable="true"],[data-sensitive],output,[autocomplete*="password" i],[autocomplete*="token" i]',
        ),
      );
      for (const selector of this.#options.sensitiveSelectors ?? []) masks.push(frame.locator(selector));
    }
    return masks;
  }
}
