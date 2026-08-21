import { ApprovalAuthority } from "../approval/index.js";
import { canonicalArtifactDigest } from "../catalog/index.js";
import { CapabilityArtifactV2Schema, type CapabilityArtifactV2 } from "../domain/index.js";
import {
  TargetInstanceProfileV2Schema,
  bindArtifactToTargetProfile,
} from "../profiles/targetProfileV2.js";
import { ReplayRunnerV2 } from "../replay/replayRunnerV2.js";
import type { Redactor } from "../safety/redactor.js";
import {
  SessionManager,
  type SessionLease,
  type SessionPrincipal,
} from "../sessions/index.js";
import { PlaywrightSurface } from "../surface/playwright/playwrightSurface.js";
import { PlaywrightReplayRuntimeV2 } from "../surface/playwright/runtimeV2.js";

export type MeridianBootstrapRoleV2 = "teller" | "supervisor";

export interface MeridianBootstrapCredentialsV2 {
  readonly operator: string;
  readonly password: string;
  readonly branch: "MAIN-001" | "WEST-014" | "EAST-022";
  readonly role: MeridianBootstrapRoleV2;
}

export type RetainedSessionBootstrapErrorCodeV2 =
  | "CREDENTIAL_PROFILE_MISSING"
  | "INVALID_BRANCH"
  | "INVALID_ORIGIN"
  | "AUTHENTICATION_FAILED"
  | "SESSION_RETENTION_FAILED";

export class RetainedSessionBootstrapErrorV2 extends Error {
  readonly code: RetainedSessionBootstrapErrorCodeV2;

  constructor(
    code: RetainedSessionBootstrapErrorCodeV2,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RetainedSessionBootstrapErrorV2";
    this.code = code;
  }
}

export function meridianBootstrapCredentialsFromEnvironmentV2(
  role: MeridianBootstrapRoleV2,
  branchValue = "MAIN-001",
  environment: NodeJS.ProcessEnv = process.env,
): MeridianBootstrapCredentialsV2 {
  const prefix = role === "teller" ? "MERIDIAN_TELLER" : "MERIDIAN_SUPERVISOR";
  const password = environment[`${prefix}_PASSWORD`];
  if (!password) {
    throw new RetainedSessionBootstrapErrorV2(
      "CREDENTIAL_PROFILE_MISSING",
      `Server-owned ${role} MERIDIAN credential profile is not configured`,
    );
  }
  const branch = branchValue.trim();
  if (branch !== "MAIN-001" && branch !== "WEST-014" && branch !== "EAST-022") {
    throw new RetainedSessionBootstrapErrorV2(
      "INVALID_BRANCH",
      "MERIDIAN branch must be MAIN-001, WEST-014, or EAST-022",
    );
  }
  return Object.freeze({
    operator: environment[`${prefix}_OPERATOR`]?.trim() || (role === "teller" ? "teller1" : "super1"),
    password,
    branch,
    role,
  });
}

export interface RetainedMeridianSessionV2 {
  readonly surface: PlaywrightSurface;
  readonly sessionRef: string;
  readonly principal: SessionPrincipal;
  close(): Promise<void>;
}

export interface BootstrapRetainedMeridianSessionOptionsV2 {
  readonly surface: PlaywrightSurface;
  readonly origin: string;
  readonly role: MeridianBootstrapRoleV2;
  /** Exact approved, model-discovered sign-on artifact from the published catalog. */
  readonly signOnArtifact: CapabilityArtifactV2;
  readonly signOnArtifactDigest: string;
  readonly branch?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly redactor?: Redactor;
  readonly sessions?: SessionManager<PlaywrightSurface>;
  readonly now?: () => Date;
}

/**
 * Authenticates through the reviewed sign-on artifact, then retains and leases
 * that exact browser context through SessionManager. Credentials are resolved
 * only from the existing role-specific server environment convention.
 */
export async function bootstrapRetainedMeridianSessionV2(
  options: BootstrapRetainedMeridianSessionOptionsV2,
): Promise<RetainedMeridianSessionV2> {
  const credentials = meridianBootstrapCredentialsFromEnvironmentV2(
    options.role,
    options.branch ?? "MAIN-001",
    options.environment,
  );
  options.redactor?.register(credentials.operator);
  options.redactor?.register(credentials.password);
  let target: URL;
  try {
    target = new URL(options.origin);
  } catch (error) {
    throw new RetainedSessionBootstrapErrorV2(
      "INVALID_ORIGIN",
      "MERIDIAN retained-session origin must be an absolute HTTP(S) URL",
      { cause: error },
    );
  }
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username.length > 0 ||
    target.password.length > 0
  ) {
    throw new RetainedSessionBootstrapErrorV2(
      "INVALID_ORIGIN",
      "MERIDIAN retained-session origin must be credential-free HTTP(S)",
    );
  }
  const origin = target.origin;
  const signOnArtifact = CapabilityArtifactV2Schema.parse(options.signOnArtifact);
  if (
    signOnArtifact.capability.id !== "session.sign_on" ||
    signOnArtifact.capability.approval !== "approved" ||
    signOnArtifact.provenance.source !== "discovery" ||
    canonicalArtifactDigest(signOnArtifact) !== options.signOnArtifactDigest
  ) {
    throw new RetainedSessionBootstrapErrorV2(
      "AUTHENTICATION_FAILED",
      "Retained discovery requires the exact approved model-discovered sign-on artifact",
    );
  }
  const profile = TargetInstanceProfileV2Schema.parse({
    schemaVersion: "1.0",
    id: "discovery-cli-retained-session",
    vendorProduct: signOnArtifact.compatibility.vendorProduct,
    surfaceAdapter: signOnArtifact.compatibility.surfaceAdapter,
    appVersion: signOnArtifact.compatibility.appVersion,
    origin,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  });
  const binding = bindArtifactToTargetProfile(
    signOnArtifact,
    options.signOnArtifactDigest,
    profile,
  );
  const sessions = options.sessions ?? new SessionManager<PlaywrightSurface>();
  let registered = false;
  let lease: SessionLease<PlaywrightSurface> | undefined;
  try {
    await options.surface.start(binding.artifact.compatibility.entryPoint);
    sessions.registerProvisioning(options.surface.sessionRef, options.surface);
    registered = true;
    const signOn = await new ReplayRunnerV2({
      artifact: binding.artifact,
      artifactDigest: binding.baseArtifactDigest,
      targetProfileDigest: binding.targetProfileDigest,
      inputs: {
        operator: credentials.operator,
        password: credentials.password,
        branch: credentials.branch,
      },
      runtime: new PlaywrightReplayRuntimeV2(options.surface, binding.artifact),
      approvalAuthority: new ApprovalAuthority(),
      ...(options.redactor ? { redactor: options.redactor } : {}),
      currentPrincipalRole: () => credentials.role,
    }).run();
    if (signOn.status !== "terminal" || signOn.result.status !== "success") {
      throw new RetainedSessionBootstrapErrorV2(
        "AUTHENTICATION_FAILED",
        "MERIDIAN retained-session authentication did not reach the reviewed menu checkpoint",
      );
    }
    const principal: SessionPrincipal = {
      operatorId: credentials.operator,
      role: credentials.role,
      branch: credentials.branch,
    };
    sessions.activate(options.surface.sessionRef, principal);
    lease = await sessions.acquire(options.surface.sessionRef, `discovery-bootstrap.${options.surface.sessionId}`);
    if (lease.resource !== options.surface || lease.sessionRef !== options.surface.sessionRef) {
      throw new RetainedSessionBootstrapErrorV2(
        "SESSION_RETENTION_FAILED",
        "Authenticated browser session could not be retained exactly",
      );
    }
    let closed = false;
    return Object.freeze({
      surface: lease.resource,
      sessionRef: lease.sessionRef,
      principal: lease.principal,
      close: async () => {
        if (closed) return;
        closed = true;
        await lease?.release().catch(() => undefined);
        await sessions.revoke(options.surface.sessionRef);
      },
    });
  } catch (error) {
    if (lease) await lease.release().catch(() => undefined);
    if (registered) await sessions.revoke(options.surface.sessionRef).catch(() => undefined);
    else await options.surface.close().catch(() => undefined);
    if (error instanceof RetainedSessionBootstrapErrorV2) throw error;
    throw new RetainedSessionBootstrapErrorV2(
      "SESSION_RETENTION_FAILED",
      "MERIDIAN retained-session bootstrap failed closed",
      { cause: error },
    );
  }
}
