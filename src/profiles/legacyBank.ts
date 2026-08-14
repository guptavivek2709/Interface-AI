import { z } from "zod";
import {
  BusinessOutcomeSpecSchema,
  ExceptionSpecSchema,
  PolicyConfigSchema,
  RecoverySpecSchema,
  TargetRefSchema,
  type PolicyConfig,
} from "../domain/index.js";

const FRAME_PATH = [{ title: "Core banking workspace" }] as const;

export const LEGACY_BANK_OUTCOME_CODES = {
  MEMBER_NOT_FOUND: "MEMBER_NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
} as const;

export const LEGACY_BANK_RECOVERY_CODES = {
  TRAINING_NOTICE: "TRAINING_NOTICE",
} as const;

export const LEGACY_BANK_INTERVENTION_CODES = {
  SESSION_EXPIRED: "SESSION_EXPIRED",
} as const;

export const LegacyBankProfileSchema = z
  .object({
    id: z.literal("legacy-bank-training"),
    surfaceAdapter: z.literal("playwright-web"),
    entryPoint: z.string().url(),
    policy: PolicyConfigSchema,
    targets: z.array(TargetRefSchema),
    businessOutcomes: z.array(BusinessOutcomeSpecSchema),
    recoveries: z.array(RecoverySpecSchema),
    exceptions: z.array(ExceptionSpecSchema),
  })
  .strict();
export type LegacyBankProfile = z.infer<typeof LegacyBankProfileSchema>;

function normalizedOrigin(value: string | URL): string {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("HTTP(S) origin required");
  if (url.username || url.password) throw new Error("Credential-bearing origins are forbidden");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Expected an origin without path, query, or fragment");
  }
  return url.origin;
}

export function legacyBankPolicy(origin: string | URL): PolicyConfig {
  const allowedOrigin = normalizedOrigin(origin);
  return PolicyConfigSchema.parse({
    allowedOrigins: [allowedOrigin],
    allowedRoutes: [
      { origin: allowedOrigin, path: "/", match: "exact" },
      { origin: allowedOrigin, path: "/index.html", match: "exact" },
      { origin: allowedOrigin, path: "/workspace", match: "exact" },
      { origin: allowedOrigin, path: "/workspace/search", match: "exact" },
      { origin: allowedOrigin, path: "/workspace/member", match: "exact" },
      { origin: allowedOrigin, path: "/workspace/sub-account/new", match: "exact" },
      { origin: allowedOrigin, path: "/workspace/sub-account/review", match: "exact" },
    ],
    allowedActions: ["click", "fill", "select", "extract", "press"],
    deniedActions: ["upload", "download", "execute", "submit"],
    maxRisk: "medium",
  });
}

export function createLegacyBankProfile(origin: string | URL): LegacyBankProfile {
  const allowedOrigin = normalizedOrigin(origin);
  return LegacyBankProfileSchema.parse({
    id: "legacy-bank-training",
    surfaceAdapter: "playwright-web",
    entryPoint: `${allowedOrigin}/`,
    policy: legacyBankPolicy(allowedOrigin),
    targets: [
      {
        id: "trainingNoticeDismiss",
        description: "Dismiss the known synthetic training interstitial.",
        framePath: FRAME_PATH,
        strategies: [
          { kind: "role", role: "button", name: "Dismiss training notice", exact: true },
          { kind: "text", text: "Dismiss training notice", exact: true },
        ],
        cardinality: "exactly_one",
        rationale: "Accessible role/name is tenant-neutral; exact visible text is a deterministic fallback.",
      },
      {
        id: "restoreTrainingSession",
        description: "Restore an expired synthetic training session during operator handoff.",
        framePath: FRAME_PATH,
        strategies: [
          { kind: "role", role: "button", name: "Restore training session", exact: true },
          { kind: "text", text: "Restore training session", exact: true },
        ],
        cardinality: "exactly_one",
        rationale: "The explicit dialog action is safer than positional or generated-ID targeting.",
      },
    ],
    businessOutcomes: [
      {
        code: "MEMBER_NOT_FOUND",
        description: "The lookup completed successfully but no member record exists.",
        condition: { kind: "text_visible", text: "No matching member", exact: true },
      },
    ],
    recoveries: [
      {
        code: "TRAINING_NOTICE",
        description: "Dismiss the known notice and continue the same deterministic step.",
        condition: { kind: "target_visible", targetId: "trainingNoticeDismiss", visible: true },
        strategy: "dismiss",
        action: { kind: "click", targetId: "trainingNoticeDismiss" },
        maxAttempts: 1,
      },
    ],
    exceptions: [
      {
        code: "PERMISSION_DENIED",
        description: "The operator lacks authorization to view the requested relationship.",
        condition: { kind: "text_visible", text: "Permission denied", exact: true },
        disposition: "failure",
      },
      {
        code: "SESSION_EXPIRED",
        description: "Pause and let a human restore the same live training session.",
        condition: {
          kind: "all",
          conditions: [
            { kind: "text_visible", text: "Session expired", exact: true },
            { kind: "target_visible", targetId: "restoreTrainingSession", visible: true },
          ],
        },
        disposition: "intervention",
      },
    ],
  });
}

export const legacyBankProfile = createLegacyBankProfile;
