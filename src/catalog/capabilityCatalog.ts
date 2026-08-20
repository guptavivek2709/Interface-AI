import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  CapabilityArtifactSchema,
  CapabilityArtifactV2Schema,
  type CapabilityArtifact,
  type CapabilityArtifactV2,
} from "../domain/index.js";

export type CatalogArtifact = CapabilityArtifact | CapabilityArtifactV2;
export type CatalogSchemaVersion = CatalogArtifact["schemaVersion"];
export type CatalogApproval = CatalogArtifact["capability"]["approval"];
export type CatalogRisk = CapabilityArtifactV2["capability"]["risk"];

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type CatalogInputMetadata = DeepReadonly<
  CapabilityArtifact["inputs"][number] | CapabilityArtifactV2["inputs"][number]
>;
export type CatalogOutputMetadata = DeepReadonly<
  CapabilityArtifact["outputs"][number] | CapabilityArtifactV2["outputs"][number]
>;

export interface CapabilityMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly schemaVersion: CatalogSchemaVersion;
  readonly approval: CatalogApproval;
  readonly risk: CatalogRisk;
  readonly inputs: readonly CatalogInputMetadata[];
  readonly outputs: readonly CatalogOutputMetadata[];
  /** SHA-256 of the validated artifact's canonical JSON representation. */
  readonly digest: string;
}

export interface CapabilityCatalogEntry {
  readonly metadata: CapabilityMetadata;
  readonly artifact: DeepReadonly<CatalogArtifact>;
}

export interface CapabilityCatalogOptions {
  /** Trusted startup configuration. Catalog lookup never accepts filesystem paths. */
  directories: readonly string[];
}

export interface CatalogQueryOptions {
  /** Draft and retired artifacts are hidden unless callers explicitly opt in. */
  visibility?: "approved" | "all";
}

export type CapabilityCatalogErrorCode =
  | "DIRECTORY_INVALID"
  | "ARTIFACT_INVALID"
  | "DUPLICATE_CAPABILITY";

export class CapabilityCatalogError extends Error {
  readonly code: CapabilityCatalogErrorCode;

  constructor(code: CapabilityCatalogErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CapabilityCatalogError";
    this.code = code;
  }
}

interface DiscoveredFile {
  absolutePath: string;
  sourceLabel: string;
}

interface LoadedEntry extends CapabilityCatalogEntry {
  readonly sourceLabel: string;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (value === null || typeof value !== "object") return value as DeepReadonly<T>;
  if (seen.has(value)) return value as DeepReadonly<T>;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value) as DeepReadonly<T>;
}

/**
 * Deterministic JSON encoding used for artifact identity. Object keys are sorted
 * recursively; array order and JSON scalar semantics are preserved.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const properties = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${properties.join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

export function canonicalArtifactDigest(artifact: CatalogArtifact): string {
  return createHash("sha256").update(canonicalJson(artifact), "utf8").digest("hex");
}

function parseArtifact(value: unknown, sourceLabel: string): CatalogArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityCatalogError(
      "ARTIFACT_INVALID",
      `${sourceLabel} is not a capability artifact object.`,
    );
  }
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  try {
    if (schemaVersion === "1.0") return CapabilityArtifactSchema.parse(value);
    if (schemaVersion === "2.0") return CapabilityArtifactV2Schema.parse(value);
  } catch (error) {
    throw new CapabilityCatalogError(
      "ARTIFACT_INVALID",
      `${sourceLabel} failed ${String(schemaVersion)} capability artifact validation.`,
      { cause: error },
    );
  }
  throw new CapabilityCatalogError(
    "ARTIFACT_INVALID",
    `${sourceLabel} has unsupported capability schema version ${JSON.stringify(schemaVersion)}.`,
  );
}

function deriveV1Risk(artifact: CapabilityArtifact): CatalogRisk {
  if (artifact.steps.some((step) => step.risk === "irreversible")) return "irreversible";
  if (artifact.steps.some((step) => step.risk === "reversible")) return "write";
  return "read";
}

function metadataFor(artifact: CatalogArtifact): CapabilityMetadata {
  return deepFreeze({
    id: artifact.capability.id,
    name: artifact.capability.name,
    description: artifact.capability.description,
    tags: artifact.capability.tags,
    version: artifact.capability.version,
    schemaVersion: artifact.schemaVersion,
    approval: artifact.capability.approval,
    risk: artifact.schemaVersion === "2.0" ? artifact.capability.risk : deriveV1Risk(artifact),
    inputs: artifact.inputs,
    outputs: artifact.outputs,
    digest: canonicalArtifactDigest(artifact),
  });
}

function capabilityKey(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

function compareMetadata(left: CapabilityMetadata, right: CapabilityMetadata): number {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.version !== right.version) return left.version < right.version ? -1 : 1;
  return 0;
}

function visible(entry: CapabilityCatalogEntry, options: CatalogQueryOptions): boolean {
  return options.visibility === "all" || entry.metadata.approval === "approved";
}

async function discoverJsonFiles(configuredDirectory: string, rootIndex: number): Promise<DiscoveredFile[]> {
  const configured = path.resolve(configuredDirectory);
  let configuredStat;
  try {
    configuredStat = await lstat(configured);
  } catch (error) {
    throw new CapabilityCatalogError(
      "DIRECTORY_INVALID",
      `Configured capability directory ${rootIndex + 1} does not exist or cannot be read.`,
      { cause: error },
    );
  }
  if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
    throw new CapabilityCatalogError(
      "DIRECTORY_INVALID",
      `Configured capability directory ${rootIndex + 1} must be a real directory, not a file or symbolic link.`,
    );
  }

  const root = await realpath(configured);
  const files: DiscoveredFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(root, candidate);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new CapabilityCatalogError(
          "DIRECTORY_INVALID",
          `Capability directory ${rootIndex + 1} contained a path outside its configured root.`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw new CapabilityCatalogError(
          "DIRECTORY_INVALID",
          `Capability directory ${rootIndex + 1} contains forbidden symbolic link ${JSON.stringify(relative)}.`,
        );
      }
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile() && path.extname(entry.name).toLocaleLowerCase("en-US") === ".json") {
        files.push({
          absolutePath: candidate,
          sourceLabel: `capability directory ${rootIndex + 1}/${relative.split(path.sep).join("/")}`,
        });
      }
    }
  };
  await visit(root);
  return files;
}

async function loadEntry(file: DiscoveredFile): Promise<LoadedEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(file.absolutePath, "utf8")).replace(/^\uFEFF/u, "")) as unknown;
  } catch (error) {
    throw new CapabilityCatalogError(
      "ARTIFACT_INVALID",
      `${file.sourceLabel} does not contain valid UTF-8 JSON.`,
      { cause: error },
    );
  }
  const artifact = deepFreeze(parseArtifact(parsed, file.sourceLabel));
  return deepFreeze({
    artifact,
    metadata: metadataFor(artifact as CatalogArtifact),
    sourceLabel: file.sourceLabel,
  });
}

export class CapabilityCatalog {
  readonly #entries: readonly LoadedEntry[];
  readonly #byKey: ReadonlyMap<string, LoadedEntry>;

  private constructor(entries: LoadedEntry[]) {
    entries.sort((left, right) => compareMetadata(left.metadata, right.metadata));
    this.#entries = Object.freeze([...entries]);
    this.#byKey = new Map(
      entries.map((entry) => [capabilityKey(entry.metadata.id, entry.metadata.version), entry]),
    );
  }

  static async load(options: CapabilityCatalogOptions): Promise<CapabilityCatalog> {
    if (options.directories.length === 0) {
      throw new CapabilityCatalogError(
        "DIRECTORY_INVALID",
        "At least one configured capability directory is required.",
      );
    }
    const discovered: DiscoveredFile[] = [];
    for (const [index, directory] of options.directories.entries()) {
      discovered.push(...(await discoverJsonFiles(directory, index)));
    }
    const loaded: LoadedEntry[] = [];
    const sourcesByKey = new Map<string, string>();
    for (const file of discovered) {
      const entry = await loadEntry(file);
      const key = capabilityKey(entry.metadata.id, entry.metadata.version);
      const existingSource = sourcesByKey.get(key);
      if (existingSource) {
        throw new CapabilityCatalogError(
          "DUPLICATE_CAPABILITY",
          `Capability ${entry.metadata.id}@${entry.metadata.version} is duplicated by ${existingSource} and ${entry.sourceLabel}.`,
        );
      }
      sourcesByKey.set(key, entry.sourceLabel);
      loaded.push(entry);
    }
    return new CapabilityCatalog(loaded);
  }

  /** Build a catalog from reviewed, code-bundled artifacts without filesystem lookup. */
  static fromArtifacts(values: readonly unknown[]): CapabilityCatalog {
    const loaded = values.map((value, index) => {
      const sourceLabel = `bundled capability ${index + 1}`;
      const artifact = deepFreeze(parseArtifact(structuredClone(value), sourceLabel));
      return deepFreeze({
        artifact,
        metadata: metadataFor(artifact as CatalogArtifact),
        sourceLabel,
      });
    });
    const sourcesByKey = new Map<string, string>();
    for (const entry of loaded) {
      const key = capabilityKey(entry.metadata.id, entry.metadata.version);
      const existing = sourcesByKey.get(key);
      if (existing) {
        throw new CapabilityCatalogError(
          "DUPLICATE_CAPABILITY",
          `Capability ${entry.metadata.id}@${entry.metadata.version} is duplicated by ${existing} and ${entry.sourceLabel}.`,
        );
      }
      sourcesByKey.set(key, entry.sourceLabel);
    }
    return new CapabilityCatalog(loaded);
  }

  list(options: CatalogQueryOptions = {}): readonly CapabilityMetadata[] {
    return Object.freeze(
      this.#entries.filter((entry) => visible(entry, options)).map((entry) => entry.metadata),
    );
  }

  get(
    id: string,
    version: string,
    options: CatalogQueryOptions = {},
  ): CapabilityMetadata | undefined {
    const entry = this.#byKey.get(capabilityKey(id, version));
    return entry && visible(entry, options) ? entry.metadata : undefined;
  }

  resolve(
    id: string,
    version: string,
    options: CatalogQueryOptions = {},
  ): CapabilityCatalogEntry | undefined {
    const entry = this.#byKey.get(capabilityKey(id, version));
    if (!entry || !visible(entry, options)) return undefined;
    return entry;
  }
}
