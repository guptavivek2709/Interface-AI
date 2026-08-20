import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Redactor } from "../safety/redactor.js";

export type EvidenceKind = "screenshot" | "dom" | "json" | "text" | "attachment";

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  /** Portable, run-relative path; safe to serialize in a capability manifest. */
  path: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  masked?: boolean;
  redacted?: boolean;
}

export interface EvidenceStoreOptions {
  rootDirectory: string;
  runId?: string;
  redactor?: Redactor;
  now?: () => Date;
  /** Injectable only for deterministic atomic-write failure tests. */
  renameFile?: (source: string, destination: string) => Promise<void>;
}

export interface ScreenshotSaveOptions {
  /** Must be true: unmasked screenshots are not accepted into evidence storage. */
  masked: true;
  mimeType?: "image/png" | "image/jpeg";
}

export interface ScreenshotCaptureTarget {
  screenshot(options: {
    mask: readonly unknown[];
    maskColor: string;
    animations: "disabled";
    caret: "hide";
    fullPage?: boolean;
    type: "png";
  }): Promise<Buffer>;
}

export interface CaptureScreenshotOptions {
  /** Playwright locators (kept as unknown here to avoid coupling this layer). */
  masks?: readonly unknown[];
  maskColor?: string;
  fullPage?: boolean;
}

export interface EvidenceManifest {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  metadata: unknown;
  evidence: readonly EvidenceRef[];
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/** Convert an operator/model-provided label into one safe path component. */
export function safeEvidenceName(value: string, fallback = "evidence"): string {
  const originalBase = basename(value.replaceAll("\\", "/"));
  const withoutExtension = originalBase.slice(0, originalBase.length - extname(originalBase).length);
  let result = withoutExtension
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[. -]+|[. -]+$/gu, "")
    .replace(/-+/gu, "-")
    .slice(0, 80);
  if (result.length === 0 || result === "." || result === ".." || WINDOWS_RESERVED.test(result)) {
    result = fallback;
  }
  return result;
}

function assertInside(parent: string, child: string): void {
  const pathFromParent = relative(parent, child);
  if (pathFromParent === ".." || pathFromParent.startsWith(`..${sep}`) || resolve(child) === resolve(parent)) {
    throw new Error("Evidence path escaped its run directory.");
  }
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function sanitizeDom(html: string, redactor: Redactor): string {
  let output = redactor.redactString(html);
  // A snapshot is diagnostic data, never executable content. Remove active
  // elements and navigation/event attributes even though the API also serves
  // HTML evidence as an inert text attachment.
  output = output.replace(
    /<\s*(script|iframe|object|embed)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu,
    "<!-- active content removed -->",
  );
  output = output.replace(/<\s*(?:script|iframe|object|embed|base|link|meta)\b[^>]*\/?\s*>/giu, "");
  output = output.replace(
    /\s(?:on[a-z]+|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu,
    "",
  );
  output = output.replace(
    /(\s(?:href|src|action|formaction)\s*=\s*)(["'])([\s\S]*?)\2/giu,
    (_match, prefix: string, quote: string) => `${prefix}${quote}#${quote}`,
  );
  // Surface snapshots already replace these contents before serialization.
  // This defense-in-depth pass also protects externally supplied snapshots.
  output = output.replace(
    /(<([a-z][\w:-]*)\b[^>]*\bdata-sensitive(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>)[\s\S]*?(<\/\2>)/giu,
    (_match, open: string, _tag: string, close: string) =>
      `${open}${redactor.replacement}${close}`,
  );
  output = output.replace(
    /(<output\b[^>]*>)[\s\S]*?(<\/output>)/giu,
    (_match, open: string, close: string) => `${open}${redactor.replacement}${close}`,
  );
  // DOM evidence is diagnostic; persisting live form values is never necessary.
  output = output.replace(
    /(\s(?:value|data-(?:token|secret|password)|autocomplete-token)\s*=\s*)(["'])([\s\S]*?)\2/giu,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${redactor.replacement}${quote}`,
  );
  output = output.replace(
    /(<select\b[^>]*>)[\s\S]*?(<\/select>)/giu,
    (_match, open: string, close: string) => `${open}${redactor.replacement}${close}`,
  );
  output = output.replace(
    /(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/giu,
    (_match, open: string, close: string) => `${open}${redactor.replacement}${close}`,
  );
  return output;
}

export class EvidenceStore {
  readonly rootDirectory: string;
  readonly runId: string;
  readonly runDirectory: string;
  readonly redactor: Redactor;

  private readonly now: () => Date;
  private readonly renameFile: (source: string, destination: string) => Promise<void>;
  private readonly references: EvidenceRef[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options: EvidenceStoreOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.runId = safeEvidenceName(options.runId ?? randomUUID(), "run");
    this.runDirectory = resolve(this.rootDirectory, this.runId);
    assertInside(this.rootDirectory, this.runDirectory);
    this.redactor = options.redactor ?? new Redactor();
    this.now = options.now ?? (() => new Date());
    this.renameFile = options.renameFile ?? rename;
  }

  static async create(options: EvidenceStoreOptions): Promise<EvidenceStore> {
    const store = new EvidenceStore(options);
    await store.initialize();
    return store;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.runDirectory, { recursive: true });
    this.initialized = true;
  }

  list(): readonly EvidenceRef[] {
    return this.references.map((reference) => ({ ...reference }));
  }

  resolve(reference: EvidenceRef | string): string {
    const relativePath = typeof reference === "string" ? reference : reference.path;
    if (relativePath.includes("\\") || relativePath.startsWith("/") || /^[a-z]:/iu.test(relativePath)) {
      throw new TypeError("Evidence reference must be a portable relative path.");
    }
    const absolutePath = resolve(this.runDirectory, relativePath);
    assertInside(this.runDirectory, absolutePath);
    return absolutePath;
  }

  async saveMaskedScreenshot(
    name: string,
    bytes: Uint8Array,
    options: ScreenshotSaveOptions = { masked: true },
  ): Promise<EvidenceRef> {
    if (options.masked !== true) throw new TypeError("Only masked screenshots may be persisted.");
    const mimeType = options.mimeType ?? "image/png";
    const extension = mimeType === "image/jpeg" ? ".jpg" : ".png";
    return this.saveBytes("screenshot", "screenshots", name, extension, bytes, mimeType, {
      masked: true,
    });
  }

  async captureMaskedScreenshot(
    name: string,
    target: ScreenshotCaptureTarget,
    options: CaptureScreenshotOptions = {},
  ): Promise<EvidenceRef> {
    const screenshotOptions = {
      mask: options.masks ?? [],
      maskColor: options.maskColor ?? "#111111",
      animations: "disabled" as const,
      caret: "hide" as const,
      type: "png" as const,
      ...(options.fullPage === undefined ? {} : { fullPage: options.fullPage }),
    };
    const bytes = await target.screenshot(screenshotOptions);
    return this.saveMaskedScreenshot(name, bytes, { masked: true, mimeType: "image/png" });
  }

  async saveDomSnapshot(name: string, html: string): Promise<EvidenceRef> {
    const safeHtml = sanitizeDom(html, this.redactor);
    return this.saveBytes(
      "dom",
      "dom",
      name,
      ".html",
      Buffer.from(safeHtml, "utf8"),
      "text/html; charset=utf-8",
      { redacted: true },
    );
  }

  async saveJson(name: string, value: unknown): Promise<EvidenceRef> {
    const safeValue = this.redactor.redact(value);
    const bytes = Buffer.from(`${JSON.stringify(safeValue, null, 2)}\n`, "utf8");
    return this.saveBytes("json", "data", name, ".json", bytes, "application/json", {
      redacted: true,
    });
  }

  async saveText(name: string, value: string): Promise<EvidenceRef> {
    const bytes = Buffer.from(this.redactor.redactString(value), "utf8");
    return this.saveBytes("text", "text", name, ".txt", bytes, "text/plain; charset=utf-8", {
      redacted: true,
    });
  }

  async writeManifest(metadata: unknown = {}): Promise<EvidenceRef> {
    const manifest: EvidenceManifest = {
      schemaVersion: 1,
      runId: this.runId,
      createdAt: this.now().toISOString(),
      metadata: this.redactor.redact(metadata),
      evidence: this.list(),
    };
    const safe = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    // The manifest itself is intentionally not inserted into its evidence list.
    return this.saveBytes("json", "", "manifest", ".json", safe, "application/json", {
      redacted: true,
    }, false);
  }

  /**
   * Register a file that was written by a redacting evidence producer after it
   * has been fully flushed and closed. The file is hashed at registration time
   * and is then covered by the final manifest written afterwards.
   */
  async registerFinalizedFile(
    relativePath: string,
    kind: EvidenceKind,
    mimeType: string,
    flags: Pick<EvidenceRef, "masked" | "redacted">,
  ): Promise<EvidenceRef> {
    if (
      !relativePath ||
      relativePath.includes("\\") ||
      relativePath.startsWith("/") ||
      relativePath.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
    ) {
      throw new TypeError("Finalized evidence path is invalid");
    }
    let result: EvidenceRef | undefined;
    await this.enqueue(async () => {
      const absolute = this.resolve(relativePath);
      const payload = await readFile(absolute);
      if (this.references.some((reference) => reference.path === portablePath(relativePath))) {
        throw new TypeError("Finalized evidence file is already registered");
      }
      const createdAt = this.now();
      if (!Number.isFinite(createdAt.getTime())) throw new TypeError("Clock returned an invalid date.");
      result = {
        id: randomUUID(),
        kind,
        path: portablePath(relativePath),
        mimeType,
        sha256: createHash("sha256").update(payload).digest("hex"),
        bytes: payload.byteLength,
        createdAt: createdAt.toISOString(),
        ...flags,
      };
      this.references.push(result);
    });
    return result as EvidenceRef;
  }

  async read(reference: EvidenceRef): Promise<Buffer> {
    return readFile(this.resolve(reference));
  }

  private async saveBytes(
    kind: EvidenceKind,
    folder: string,
    name: string,
    extension: string,
    bytes: Uint8Array,
    mimeType: string,
    flags: Pick<EvidenceRef, "masked" | "redacted">,
    track = true,
  ): Promise<EvidenceRef> {
    await this.initialize();
    let result: EvidenceRef | undefined;
    await this.enqueue(async () => {
      const directory = resolve(this.runDirectory, folder);
      if (directory !== this.runDirectory) assertInside(this.runDirectory, directory);
      await mkdir(directory, { recursive: true });
      const stem = safeEvidenceName(name);
      const destination = await this.availablePath(directory, stem, extension);
      const payload = Buffer.from(bytes);
      await this.atomicWrite(destination, payload);
      const createdAt = this.now();
      if (!Number.isFinite(createdAt.getTime())) throw new TypeError("Clock returned an invalid date.");
      result = {
        id: randomUUID(),
        kind,
        path: portablePath(relative(this.runDirectory, destination)),
        mimeType,
        sha256: createHash("sha256").update(payload).digest("hex"),
        bytes: payload.byteLength,
        createdAt: createdAt.toISOString(),
        ...flags,
      };
      if (track) this.references.push(result);
    });
    return result as EvidenceRef;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async availablePath(directory: string, stem: string, extension: string): Promise<string> {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const candidate = join(directory, `${stem}${suffix}${extension}`);
      try {
        await stat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
        throw error;
      }
    }
    throw new Error(`Unable to allocate an evidence filename for ${stem}.`);
  }

  private async atomicWrite(destination: string, bytes: Uint8Array): Promise<void> {
    assertInside(this.runDirectory, destination);
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(6).toString("hex")}.tmp`);
    assertInside(this.runDirectory, temporary);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await this.renameFile(temporary, destination);
    } catch (error) {
      // Temporary files live inside the served run directory, so they must not
      // remain available for accidental enumeration after a failed rename.
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
