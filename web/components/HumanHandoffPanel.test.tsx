import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HumanHandoffController } from "../hooks/useHumanHandoff";
import type { ConsolePrincipal, HumanIntervention, RunRecord } from "../types";
import { HumanHandoffPanel } from "./HumanHandoffPanel";

const principal: ConsolePrincipal = {
  id: "console:teller",
  displayName: "Teller",
  role: "teller",
};

const controller: HumanHandoffController = {
  busy: null,
  error: "",
  invitation: null,
  take: vi.fn(async () => undefined),
  perform: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  createInvitation: vi.fn(async () => undefined),
  redeem: vi.fn(async () => undefined),
  clearInvitation: vi.fn(),
};

function runAt(state: HumanIntervention["state"]): RunRecord {
  return {
    id: "run-handoff",
    capabilityId: "member.update_contact",
    capabilityVersion: "2.0.0",
    phase: "awaiting_human",
    journal: [],
    incidents: [],
    intervention: {
      interventionId: "22222222-2222-4222-8222-222222222222",
      runId: "run-handoff",
      stepId: "restore_checkpoint",
      reasonCode: "SESSION_EXPIRED",
      action: "restore_session",
      state,
      createdAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2099-08-20T00:05:00.000Z",
      sameLiveSession: true,
    },
  };
}

function renderState(state: HumanIntervention["state"]): string {
  return renderToStaticMarkup(
    <HumanHandoffPanel
      run={runAt(state)}
      principal={principal}
      controller={controller}
      online
    />,
  );
}

describe("same-session handoff controls", () => {
  it("exposes take, perform, then resume only at their authoritative states", () => {
    expect(renderState("awaiting_human")).toContain("Take same-session control");
    expect(renderState("human_active")).toContain("Confirm session restoration");

    const completed = renderState("action_completed");
    expect(completed).toContain("Resume approved automation");
    expect(completed).toContain("human action completed");

    const revalidating = renderState("revalidating");
    expect(revalidating).not.toContain("Resume approved automation");
    expect(revalidating).toContain("service is revalidating");
  });
});
