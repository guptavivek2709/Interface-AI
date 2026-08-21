import path from "node:path";
import { CapabilityArtifactV2Schema } from "../domain/index.js";
import { CapabilityCatalog } from "./capabilityCatalog.js";

export const MERIDIAN_PRODUCTION_CAPABILITY_IDS = Object.freeze([
  "session.sign_on",
  "member.search_by_number",
  "member.search_by_last_name",
  "member.get_record_and_balances",
  "funds.transfer",
  "share.open",
  "member.update_information",
  "account.place_hold",
] as const);

export type ConfiguredCatalogErrorCode =
  | "CATALOG_ROOTS_NOT_SEPARATE"
  | "CATALOG_CONTENT_INVALID";

export class ConfiguredCatalogError extends Error {
  readonly code: ConfiguredCatalogErrorCode;

  constructor(code: ConfiguredCatalogErrorCode, message: string) {
    super(message);
    this.name = "ConfiguredCatalogError";
    this.code = code;
  }
}

export interface LoadConfiguredCapabilityCatalogOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Narrow override for isolated catalog-loader tests. */
  readonly requiredCapabilityIds?: readonly string[];
}

function configuredRoot(
  environment: NodeJS.ProcessEnv,
  name: "CAPABILITY_ARTIFACT_ROOT" | "CAPABILITY_LINEAGE_ROOT",
  fallback: string,
): string {
  return path.resolve(environment[name]?.trim() || fallback);
}

/**
 * Load the only supported runtime catalog: separately published, immutable V2
 * artifacts with exact approved discovery lineage. Authored/bundled artifacts
 * remain source annotations for review and are never an application runtime.
 */
export async function loadConfiguredCapabilityCatalog(
  options: LoadConfiguredCapabilityCatalogOptions = {},
): Promise<CapabilityCatalog> {
  const environment = options.environment ?? process.env;
  const artifactRoot = configuredRoot(
    environment,
    "CAPABILITY_ARTIFACT_ROOT",
    path.join("catalog", "meridian-v2", "artifacts"),
  );
  const lineageRoot = configuredRoot(
    environment,
    "CAPABILITY_LINEAGE_ROOT",
    path.join("catalog", "meridian-v2", "lineage"),
  );
  if (artifactRoot.toLocaleLowerCase("en-US") === lineageRoot.toLocaleLowerCase("en-US")) {
    throw new ConfiguredCatalogError(
      "CATALOG_ROOTS_NOT_SEPARATE",
      "CAPABILITY_ARTIFACT_ROOT and CAPABILITY_LINEAGE_ROOT must be separate directories",
    );
  }

  const catalog = await CapabilityCatalog.load({
    directories: [artifactRoot],
    lineageDirectories: [lineageRoot],
    requireDiscoveryLineage: true,
  });
  const required = options.requiredCapabilityIds ?? MERIDIAN_PRODUCTION_CAPABILITY_IDS;
  const visible = catalog.list({ visibility: "all" });
  const expected = new Set(required);
  const unexpected = visible.filter((metadata) => !expected.has(metadata.id));
  if (unexpected.length > 0 || visible.length !== required.length) {
    throw new ConfiguredCatalogError(
      "CATALOG_CONTENT_INVALID",
      `Published catalog must contain exactly: ${required.join(", ")}`,
    );
  }
  for (const capabilityId of required) {
    const entry = catalog.resolve(capabilityId, "2.0.0", { visibility: "all" });
    if (!entry) {
      throw new ConfiguredCatalogError(
        "CATALOG_CONTENT_INVALID",
        `Published catalog is missing ${capabilityId}@2.0.0`,
      );
    }
    const artifact = CapabilityArtifactV2Schema.parse(entry.artifact);
    if (
      artifact.capability.approval !== "approved" ||
      artifact.provenance.source !== "discovery" ||
      artifact.provenance.planner?.provider !== "anthropic-messages" ||
      !entry.metadata.lineage ||
      entry.metadata.lineage.provider !== "anthropic-messages" ||
      entry.metadata.lineage.discoveryRunId !== artifact.provenance.discoveryRunId ||
      entry.metadata.lineage.approvedDigest !== entry.metadata.digest
    ) {
      throw new ConfiguredCatalogError(
        "CATALOG_CONTENT_INVALID",
        `${capabilityId}@2.0.0 is not an exactly lineage-bound approved discovery artifact`,
      );
    }
  }
  return catalog;
}
