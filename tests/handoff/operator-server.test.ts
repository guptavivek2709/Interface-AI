import { afterEach, describe, expect, it } from "vitest";
import { ControlCoordinator } from "../../src/handoff/controlCoordinator.js";
import {
  OperatorServer,
  performDemoOperatorHandoff,
} from "../../src/handoff/operatorServer.js";
import type { HandoffSurface } from "../../src/surface/types.js";

const servers: OperatorServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

async function fixture() {
  const events: string[] = [];
  const clicks: string[] = [];
  const coordinator = new ControlCoordinator({
    sessionId: "same-browser-session-secret",
    eventSink: (event) => { events.push(event.type); },
  });
  const surface: HandoffSurface = {
    sessionId: "same-browser-session-secret",
    sessionRef: "opaque-target-session-secret",
    async humanClick(accessibleName) {
      clicks.push(accessibleName);
      const now = new Date().toISOString();
      return { startedAt: now, completedAt: now };
    },
  };
  await coordinator.requestIntervention({
    runId: "run-1",
    capabilityId: "training.restore",
    goal: "Restore the training session",
    stepId: "restore",
    reasonCode: "SESSION_EXPIRED",
    reason: "Sensitive target diagnostic must not cross the handoff API",
    screenshotPath: "private/screenshot.png",
    observedState: "opaque-target-session-secret",
  });
  const server = new OperatorServer({ coordinator, surface });
  servers.push(server);
  const operatorUrl = await server.start();
  return { coordinator, events, clicks, server, operatorUrl };
}

describe("OperatorServer", () => {
  it("keeps the same live session while requiring a fragment-held operator token", async () => {
    const { coordinator, events, clicks, operatorUrl } = await fixture();
    const parsed = new URL(operatorUrl);
    const token = decodeURIComponent(parsed.hash.slice(1));
    expect(token.length).toBeGreaterThan(32);

    const shell = await fetch(`${parsed.origin}/`);
    const shellText = await shell.text();
    expect(shell.status).toBe(200);
    expect(shellText).not.toContain("opaque-target-session-secret");
    expect(shellText).not.toContain(token);
    expect(shellText).not.toContain("Sensitive target diagnostic");

    const unauthorized = await fetch(`${parsed.origin}/api/intervention`);
    expect(unauthorized.status).toBe(400);
    expect(await unauthorized.text()).not.toContain("opaque-target-session-secret");

    const authorized = await fetch(`${parsed.origin}/api/intervention`, {
      headers: { "x-handoff-token": token },
    });
    const serialized = await authorized.text();
    expect(authorized.status).toBe(200);
    expect(serialized).toContain('"sameLiveSession":true');
    expect(serialized).not.toContain("sameSessionRef");
    expect(serialized).not.toContain("opaque-target-session-secret");
    expect(serialized).not.toContain("Sensitive target diagnostic");

    await performDemoOperatorHandoff(operatorUrl);
    expect(coordinator.phase).toBe("automation_active");
    expect(clicks).toEqual(["Restore training session"]);
    expect(events).toEqual(expect.arrayContaining([
      "intervention.requested",
      "control.transferred",
      "human.action.completed",
    ]));
  });

  it("rejects cross-origin mutations and oversized bodies without exposing raw errors", async () => {
    const { operatorUrl } = await fixture();
    const parsed = new URL(operatorUrl);
    const token = decodeURIComponent(parsed.hash.slice(1));
    const crossOrigin = await fetch(`${parsed.origin}/api/take`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": "https://attacker.invalid",
        "x-handoff-token": token,
      },
      body: JSON.stringify({ operatorId: "attacker" }),
    });
    expect(crossOrigin.status).toBe(400);

    const oversized = await fetch(`${parsed.origin}/api/take`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": parsed.origin,
        "x-handoff-token": token,
      },
      body: JSON.stringify({ operatorId: "x".repeat(17_000) }),
    });
    const body = await oversized.text();
    expect(oversized.status).toBe(400);
    expect(body).toContain("HANDOFF_REQUEST_REJECTED");
    expect(body).not.toContain("xxxx");
  });
});
