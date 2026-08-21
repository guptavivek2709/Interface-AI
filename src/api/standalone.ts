import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { ApprovalAuthority } from "../approval/index.js";
import { buildApiServer, credentialProfilesFromEnvironment } from "./server.js";
import { StaticConsoleIdentityProvider } from "./identity.js";
import { loadConfiguredCapabilityCatalog } from "../catalog/index.js";
import { createChatRouter } from "../chat/index.js";
import type { RunValueV2 } from "../domain/index.js";
import { createMeridianRunnerFactory } from "../execution/index.js";
import { createMeridianTargetProfile, targetProfileDigest } from "../profiles/index.js";
import { FileIdempotencyLedger, RunManager } from "../runs/index.js";
import { SessionManager, type SessionPrincipal } from "../sessions/index.js";
import type { PlaywrightSurface } from "../surface/playwright/playwrightSurface.js";

function approvalSecret(): Buffer {
  const configured = process.env.APPROVAL_SIGNING_SECRET;
  if (!configured) return randomBytes(32);
  const decoded = configured.startsWith("base64:")
    ? Buffer.from(configured.slice("base64:".length), "base64")
    : Buffer.from(configured, "utf8");
  if (decoded.byteLength < 32) throw new Error("APPROVAL_SIGNING_SECRET must contain at least 32 bytes");
  return decoded;
}

function positivePort(value: string | undefined): number {
  const port = Number(value ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  return port;
}

function boundedEnvironmentInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function chatEffort(raw: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" {
  const value = raw ?? "low";
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  throw new Error("ANTHROPIC_CHAT_EFFORT must be one of low, medium, high, xhigh, max");
}

const catalog = await loadConfiguredCapabilityCatalog();
const sessions = new SessionManager<PlaywrightSurface>({
  idleTtlMs: boundedEnvironmentInteger(
    "SESSION_IDLE_TTL_MS",
    process.env.SESSION_IDLE_TTL_MS,
    10 * 60_000,
    5_000,
    8 * 60 * 60_000,
  ),
  leaseWaitTimeoutMs: boundedEnvironmentInteger(
    "SESSION_LEASE_WAIT_TIMEOUT_MS",
    process.env.SESSION_LEASE_WAIT_TIMEOUT_MS,
    30_000,
    1_000,
    5 * 60_000,
  ),
});
const authority = new ApprovalAuthority({ secret: approvalSecret() });
const evidenceRoot = path.resolve(process.env.EVIDENCE_ROOT ?? path.join("evidence", "generated", "api-runs"));
const pendingSignOns = new Map<
  string,
  { principal: SessionPrincipal; inputs: Readonly<Record<string, RunValueV2>> }
>();
const identity = StaticConsoleIdentityProvider.fromEnvironment();
const credentials = credentialProfilesFromEnvironment();
const targetProfile = createMeridianTargetProfile({
  ...(process.env.MERIDIAN_ORIGIN ? { origin: process.env.MERIDIAN_ORIGIN } : {}),
  id: process.env.MERIDIAN_TARGET_PROFILE_ID?.trim() || "meridian.default",
});
const configuredTargetProfileDigest = targetProfileDigest(targetProfile);
const runnerFactory = createMeridianRunnerFactory({
  catalog,
  sessions,
  approvalAuthority: authority,
  evidenceRoot,
  targetProfile,
  headless: process.env.MERIDIAN_HEADFUL !== "1",
  resolveSignOn: (sessionRef) => {
    const pending = pendingSignOns.get(sessionRef);
    pendingSignOns.delete(sessionRef);
    return pending;
  },
  resolveHandoffCredentials: (principal) => {
    const profile = credentials[principal.role];
    if (!profile || (principal.operatorId && profile.operator !== principal.operatorId)) return undefined;
    return { operator: profile.operator, password: profile.password, branch: principal.branch };
  },
});
const runs = new RunManager({
  runnerFactory,
  maxConcurrentRuns: boundedEnvironmentInteger("MAX_CONCURRENT_RUNS", process.env.MAX_CONCURRENT_RUNS, 2, 1, 32),
  maxQueuedRuns: boundedEnvironmentInteger("MAX_QUEUED_RUNS", process.env.MAX_QUEUED_RUNS, 100, 1, 10_000),
  retentionTtlMs: boundedEnvironmentInteger(
    "RUN_RETENTION_TTL_MS",
    process.env.RUN_RETENTION_TTL_MS,
    8 * 60 * 60_000,
    60_000,
    30 * 24 * 60 * 60_000,
  ),
  idempotencyLedger: new FileIdempotencyLedger(
    path.resolve(process.env.IDEMPOTENCY_LEDGER_PATH ?? path.join(".meridian", "idempotency-ledger.json")),
  ),
});
const chat = createChatRouter({
  ...(process.env.ANTHROPIC_CHAT_MODEL ? { model: process.env.ANTHROPIC_CHAT_MODEL } : {}),
  timeoutMs: boundedEnvironmentInteger(
    "ANTHROPIC_CHAT_TIMEOUT_MS",
    process.env.ANTHROPIC_CHAT_TIMEOUT_MS,
    12_000,
    1_000,
    18_000,
  ),
  effort: chatEffort(process.env.ANTHROPIC_CHAT_EFFORT),
});
const app = buildApiServer({
  catalog,
  runs,
  sessions,
  chat,
  identity,
  credentials,
  evidenceRoot,
  targetProfileDigest: configuredTargetProfileDigest,
  registerPendingPrincipal: (sessionRef, principal, inputs) => {
    pendingSignOns.set(sessionRef, { principal, inputs });
  },
  clearPendingPrincipal: (sessionRef) => pendingSignOns.delete(sessionRef),
  chatRedactionSecrets: [
    process.env.MERIDIAN_CONSOLE_TELLER_ACCESS_CODE,
    process.env.MERIDIAN_CONSOLE_SUPERVISOR_ACCESS_CODE,
  ].filter((value): value is string => typeof value === "string" && value.length > 0),
  logger: process.env.NODE_ENV !== "test",
});
const sessionSweep = setInterval(() => void sessions.sweepExpired(), 30_000);
sessionSweep.unref();
app.addHook("onClose", async () => clearInterval(sessionSweep));

const webRoot = path.resolve("dist", "web");
try {
  await access(path.join(webRoot, "index.html"));
  await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "API route not found" } });
    }
    return reply.sendFile("index.html");
  });
} catch {
  app.get("/", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(
      "<!doctype html><title>MERIDIAN Capability Console</title><h1>Frontend not built</h1><p>Run npm run build:web, then restart.</p>",
    ),
  );
}

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = positivePort(process.env.PORT);
await app.listen({ host, port });
process.stdout.write(`MERIDIAN capability console listening at http://${host}:${port}\n`);

const shutdown = async () => {
  await app.close();
  process.exitCode = 0;
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
