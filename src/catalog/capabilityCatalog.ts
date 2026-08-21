import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { CapabilityArtifactV2Schema, type CapabilityArtifactV2 } from "../domain/index.js";
import {
  ArtifactLineageV2Schema,
  type ArtifactLineageV2,
} from "../discovery/artifactPromotionV2.js";

export type CatalogArtifact = CapabilityArtifactV2;
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

export type CatalogInputMetadata = DeepReadonly<CapabilityArtifactV2["inputs"][number]>;
export type CatalogOutputMetadata = DeepReadonly<CapabilityArtifactV2["outputs"][number]>;

export interface CapabilityMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly schemaVersion: CatalogSchemaVersion;
  readonly approval: CatalogApproval;
  readonly risk: CatalogRisk;
  /** Exact contract declaration for a same-session supervisor authorization handoff. */
  readonly supportsSupervisorHandoff: boolean;
  readonly inputs: readonly CatalogInputMetadata[];
  readonly outputs: readonly CatalogOutputMetadata[];
  /** SHA-256 of the validated artifact's canonical JSON representation. */
  readonly digest: string;
  readonly lineage?: {
    readonly lineageId: string;
    readonly discoveryRunId: string;
    readonly provider: string;
    readonly model: string;
    readonly traceDigest: string;
    readonly draftDigest: string;
    readonly reviewedDigest: string;
    readonly approvedDigest: string;
    readonly canaryRunId: string;
  };
}

export interface CapabilityCatalogEntry {
  readonly metadata: CapabilityMetadata;
  readonly artifact: DeepReadonly<CatalogArtifact>;
}

/** Exact validated artifact/lineage pairs loaded from the published catalog roots. */
export interface CapabilityDiscoveryRecord extends CapabilityCatalogEntry {
  readonly lineage: DeepReadonly<ArtifactLineageV2>;
}

export interface CapabilityCatalogOptions {
  /** Trusted startup configuration. Catalog lookup never accepts filesystem paths. */
  directories: readonly string[];
  /** Separate trusted roots containing approved external discovery lineage records. */
  lineageDirectories?: readonly string[];
  /** Require every approved, discovery-authored V2 artifact to have validated lineage. */
  requireDiscoveryLineage?: boolean;
}

export interface CatalogQueryOptions {
  /** Draft and retired artifacts are hidden unless callers explicitly opt in. */
  visibility?: "approved" | "all";
}

export type CapabilityCatalogErrorCode =
  | "DIRECTORY_INVALID"
  | "ARTIFACT_INVALID"
  | "DUPLICATE_CAPABILITY"
  | "LINEAGE_INVALID"
  | "LINEAGE_MISSING"
  | "DUPLICATE_LINEAGE";

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
  readonly lineage?: DeepReadonly<ArtifactLineageV2>;
}

interface LoadedLineage {
  readonly lineage: DeepReadonly<ArtifactLineageV2>;
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

export function canonicalArtifactDigest(artifact: DeepReadonly<CatalogArtifact>): string {
  return createHash("sha256").update(canonicalJson(artifact), "utf8").digest("hex");
}

function supportsSupervisorHandoff(artifact: DeepReadonly<CatalogArtifact>): boolean {
  if (artifact.capability.risk !== "supervisor_only") return false;
  const hasSupervisorApprovalGate = artifact.steps.some(
    (step) =>
      step.approval?.kind === "supervisor_confirmation" &&
      (step.effect === "reversible_write" || step.effect === "irreversible_commit"),
  );
  if (!hasSupervisorApprovalGate) return false;
  return artifact.runtimeStates.some(
    (state) =>
      state.category === "intervention" &&
      state.condition.kind === "http_status" &&
      state.condition.status === 403 &&
      state.effectCertainty === "not_applied" &&
      state.requiredRole === "supervisor" &&
      state.handoff?.kind === "same_session" &&
      state.handoff.action === "authenticate_supervisor" &&
      state.handoff.resume.kind === "restart_run" &&
      state.handoff.trigger?.kind === "capability_role" &&
      state.handoff.trigger.role === "supervisor" &&
      state.handoff.revalidate.length > 0,
  );
}

function parseArtifact(value: unknown, sourceLabel: string): CatalogArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityCatalogError(
      "ARTIFACT_INVALID",
      `${sourceLabel} is not a capability artifact object.`,
    );
  }
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== "2.0") {
    throw new CapabilityCatalogError(
      "ARTIFACT_INVALID",
      `${sourceLabel} has unsupported capability schema version ${JSON.stringify(schemaVersion)}.`,
    );
  }
  try {
    return CapabilityArtifactV2Schema.parse(value);
  } catch (error) {
    throw new CapabilityCatalogError(
      "ARTIFACT_INVALID",
      `${sourceLabel} failed 2.0 capability artifact validation.`,
      { cause: error },
    );
  }
}

function metadataFor(
  artifact: DeepReadonly<CatalogArtifact>,
  lineage?: DeepReadonly<ArtifactLineageV2>,
): CapabilityMetadata {
  const canary = lineage?.events.find((event) => event.type === "canary_passed");
  return deepFreeze({
    id: artifact.capability.id,
    name: artifact.capability.name,
    description: artifact.capability.description,
    tags: artifact.capability.tags,
    version: artifact.capability.version,
    schemaVersion: artifact.schemaVersion,
    approval: artifact.capability.approval,
    risk: artifact.capability.risk,
    supportsSupervisorHandoff: supportsSupervisorHandoff(artifact),
    inputs: artifact.inputs,
    outputs: artifact.outputs,
    digest: canonicalArtifactDigest(artifact),
    ...(lineage && canary?.type === "canary_passed"
      ? {
          lineage: {
            lineageId: lineage.lineageId,
            discoveryRunId: lineage.discovery.runId,
            provider: lineage.discovery.provider,
            model: lineage.discovery.model,
            traceDigest: lineage.discovery.traceDigest,
            draftDigest: lineage.draftDigest,
            reviewedDigest: lineage.reviewedDigest!,
            approvedDigest: lineage.approvedDigest!,
            canaryRunId: canary.canaryRunId,
          },
        }
      : {}),
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

async function discoverJsonFiles(
  configuredDirectory: string,
  rootIndex: number,
  kind: "capability" | "lineage" = "capability",
): Promise<DiscoveredFile[]> {
  const configured = path.resolve(configuredDirectory);
  let configuredStat;
  try {
    configuredStat = await lstat(configured);
  } catch (error) {
    throw new CapabilityCatalogError(
      "DIRECTORY_INVALID",
      `Configured ${kind} directory ${rootIndex + 1} does not exist or cannot be read.`,
      { cause: error },
    );
  }
  if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
    throw new CapabilityCatalogError(
      "DIRECTORY_INVALID",
      `Configured ${kind} directory ${rootIndex + 1} must be a real directory, not a file or symbolic link.`,
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
          `${kind === "capability" ? "Capability" : "Lineage"} directory ${rootIndex + 1} contained a path outside its configured root.`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw new CapabilityCatalogError(
          "DIRECTORY_INVALID",
          `${kind === "capability" ? "Capability" : "Lineage"} directory ${rootIndex + 1} contains forbidden symbolic link ${JSON.stringify(relative)}.`,
        );
      }
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile() && path.extname(entry.name).toLocaleLowerCase("en-US") === ".json") {
        files.push({
          absolutePath: candidate,
          sourceLabel: `${kind} directory ${rootIndex + 1}/${relative.split(path.sep).join("/")}`,
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
    metadata: metadataFor(artifact),
    sourceLabel: file.sourceLabel,
  });
}

async function loadLineage(file: DiscoveredFile): Promise<LoadedLineage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(file.absolutePath, "utf8")).replace(/^\uFEFF/u, "")) as unknown;
  } catch (error) {
    throw new CapabilityCatalogError(
      "LINEAGE_INVALID",
      `${file.sourceLabel} does not contain valid UTF-8 JSON.`,
      { cause: error },
    );
  }
  try {
    return deepFreeze({
      lineage: ArtifactLineageV2Schema.parse(parsed),
      sourceLabel: file.sourceLabel,
    });
  } catch (error) {
    throw new CapabilityCatalogError(
      "LINEAGE_INVALID",
      `${file.sourceLabel} failed artifact lineage validation.`,
      { cause: error },
    );
  }
}

function bindApprovedLineage(entry: LoadedEntry, loaded: LoadedLineage): LoadedEntry {
  const { artifact } = entry;
  const { lineage } = loaded;
  if (
    artifact.capability.approval !== "approved" ||
    artifact.provenance.source !== "discovery" ||
    lineage.stage !== "approved" ||
    lineage.discovery.mode !== "model" ||
    lineage.capabilityId !== artifact.capability.id ||
    lineage.capabilityVersion !== artifact.capability.version ||
    lineage.approvedDigest !== canonicalArtifactDigest(artifact) ||
    artifact.provenance.discoveryRunId !== lineage.discovery.runId ||
    artifact.provenance.planner?.provider !== lineage.discovery.provider ||
    artifact.provenance.planner.model !== lineage.discovery.model
  ) {
    throw new CapabilityCatalogError(
      "LINEAGE_INVALID",
      `${loaded.sourceLabel} does not bind the exact approved discovery artifact ${artifact.capability.id}@${artifact.capability.version}.`,
    );
  }
  return deepFreeze({
    artifact,
    metadata: metadataFor(artifact, lineage),
    lineage,
    sourceLabel: entry.sourceLabel,
  });
}

export class CapabilityCatalog {
  readonly #entries: readonly LoadedEntry[];
  readonly #byKey: ReadonlyMap<string, LoadedEntry>;
  readonly #discoveryRecords: readonly CapabilityDiscoveryRecord[];

  private constructor(entries: LoadedEntry[]) {
    entries.sort((left, right) => compareMetadata(left.metadata, right.metadata));
    this.#entries = Object.freeze([...entries]);
    this.#byKey = new Map(
      entries.map((entry) => [capabilityKey(entry.metadata.id, entry.metadata.version), entry]),
    );
    this.#discoveryRecords = Object.freeze(
      entries.flatMap((entry) => entry.lineage
        ? [deepFreeze({ metadata: entry.metadata, artifact: entry.artifact, lineage: entry.lineage })]
        : []),
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

    const lineageFiles: DiscoveredFile[] = [];
    for (const [index, directory] of (options.lineageDirectories ?? []).entries()) {
      lineageFiles.push(...(await discoverJsonFiles(directory, index, "lineage")));
    }
    const lineagesByKey = new Map<string, LoadedLineage>();
    for (const file of lineageFiles) {
      const candidate = await loadLineage(file);
      const key = capabilityKey(candidate.lineage.capabilityId, candidate.lineage.capabilityVersion);
      const existing = lineagesByKey.get(key);
      if (existing) {
        throw new CapabilityCatalogError(
          "DUPLICATE_LINEAGE",
          `Capability lineage ${candidate.lineage.capabilityId}@${candidate.lineage.capabilityVersion} is duplicated by ${existing.sourceLabel} and ${candidate.sourceLabel}.`,
        );
      }
      lineagesByKey.set(key, candidate);
    }

    const requireDiscoveryLineage =
      options.requireDiscoveryLineage ?? (options.lineageDirectories !== undefined);
    const bound: LoadedEntry[] = [];
    const consumedLineages = new Set<string>();
    for (const entry of loaded) {
      const key = capabilityKey(entry.metadata.id, entry.metadata.version);
      const lineage = lineagesByKey.get(key);
      if (lineage) {
        bound.push(bindApprovedLineage(entry, lineage));
        consumedLineages.add(key);
      } else {
        if (
          requireDiscoveryLineage &&
          entry.artifact.capability.approval === "approved" &&
          entry.artifact.provenance.source === "discovery"
        ) {
          throw new CapabilityCatalogError(
            "LINEAGE_MISSING",
            `Approved discovery artifact ${entry.metadata.id}@${entry.metadata.version} has no approved lineage record.`,
          );
        }
        bound.push(entry);
      }
    }
    const orphan = [...lineagesByKey.entries()].find(([key]) => !consumedLineages.has(key));
    if (orphan) {
      throw new CapabilityCatalogError(
        "LINEAGE_INVALID",
        `${orphan[1].sourceLabel} has no exact approved artifact in the configured catalog.`,
      );
    }
    return new CapabilityCatalog(bound);
  }

  /** Build a catalog from reviewed V2 artifacts without filesystem lookup. */
  static fromArtifacts(values: readonly unknown[]): CapabilityCatalog {
    const loaded = values.map((value, index) => {
      const sourceLabel = `bundled capability ${index + 1}`;
      const artifact = deepFreeze(parseArtifact(structuredClone(value), sourceLabel));
      return deepFreeze({
        artifact,
        metadata: metadataFor(artifact),
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

  /** List only exact artifact/lineage pairs actually loaded from published records. */
  listDiscoveryRecords(): readonly CapabilityDiscoveryRecord[] {
    return this.#discoveryRecords;
  }
}
