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
  /** Trusted adapter selectors for legacy regions containing synthetic PII/financial data. */
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

  async observe(): Promise<SurfaceObservation> {
    await this.waitUntilReady();
    const frames: ObservedFrame[] = [];
    const controls: ObservedControl[] = [];
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
    }

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
    });
    return {
      capturedAt: new Date().toISOString(),
      url: sanitizeUrl(this.page.url(), this.#options.redactObservedUrl),
      title: await this.page.title(),
      httpStatus: this.#mainDocumentHttpStatus,
      controls,
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
    if (!control) throw new Error(`Observed control ${action.targetRef ?? "<missing>"} does not exist`);
    const locator = await this.#resolveObservedControl(control);
    const value = action.value ? this.#resolvePlannerValue(action.value, inputs) : undefined;
    let observedValue: string | undefined;
    switch (action.kind) {
      case "click":
        await locator.click();
        break;
      case "fill":
        await locator.fill(String(value ?? ""));
        break;
      case "select": {
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
        observedValue = normalizeText(await locator.innerText().catch(async () => locator.inputValue()));
        break;
    }
    await this.waitUntilReady();
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      targetRef: control.ref,
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
    const documents: string[] = [];
    for (const frame of this.page.frames()) {
      const framePath = await this.#framePath(frame);
      const label = framePath.map((segment) => segment.title).join(" > ") || "top";
      const html = await frame
        .locator("html")
        .evaluate((root, configuredSelectors) => {
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
          const redact = (element: Element) => {
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
          };
          const selectors = [
            'input:not([type="hidden"])',
            "textarea",
            "select",
            '[contenteditable="true"]',
            "[data-sensitive]",
            "output",
            ...configuredSelectors,
          ];
          for (const element of clone.querySelectorAll(selectors.join(","))) {
            redact(element);
          }
          return `<!doctype html>\n${clone.outerHTML}`;
        }, this.#options.sensitiveSelectors ?? [])
        .catch(() => "<!-- detached frame -->");
      documents.push(`<!-- frame: ${label}; url: ${sanitizeUrl(frame.url(), this.#options.redactObservedUrl)} -->\n${html}`);
    }
    return documents.join("\n\n");
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

  async #rootForPath(framePath: FrameScopeObservation[]): Promise<LocatorRoot> {
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
