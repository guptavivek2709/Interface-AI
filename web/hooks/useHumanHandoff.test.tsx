import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HumanIntervention, RunRecord } from "../types";
import { useHumanHandoff, type HumanHandoffController } from "./useHumanHandoff";

const apiMocks = vi.hoisted(() => ({
  takeHumanControl: vi.fn(),
  performHandoffAction: vi.fn(),
  resumeHumanControl: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...apiMocks,
}));

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

let exposed: HumanHandoffController | undefined;

function Harness({ run, onRun }: { run: RunRecord; onRun(run: RunRecord): void }) {
  exposed = useHumanHandoff({
    run,
    authEpoch: 1,
    onRun,
    onUnauthorized: vi.fn(),
  });
  return null;
}

function controllerFor(run: RunRecord, onRun: (run: RunRecord) => void): HumanHandoffController {
  exposed = undefined;
  renderToStaticMarkup(<Harness run={run} onRun={onRun} />);
  if (!exposed) throw new Error("Handoff controller was not rendered");
  return exposed;
}

describe("useHumanHandoff state contract", () => {
  it("submits take, perform, and resume only in the exact server states", async () => {
    const humanActive = runAt("human_active");
    const actionCompleted = runAt("action_completed");
    const revalidating = runAt("revalidating");
    apiMocks.takeHumanControl.mockResolvedValue(humanActive);
    apiMocks.performHandoffAction.mockResolvedValue(actionCompleted);
    apiMocks.resumeHumanControl.mockResolvedValue(revalidating);
    const onRun = vi.fn();

    await controllerFor(runAt("awaiting_human"), onRun).take();
    expect(apiMocks.takeHumanControl).toHaveBeenCalledWith(
      "run-handoff",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(onRun).toHaveBeenLastCalledWith(humanActive);

    await controllerFor(humanActive, onRun).perform();
    expect(apiMocks.performHandoffAction).toHaveBeenCalledWith(
      "run-handoff",
      "22222222-2222-4222-8222-222222222222",
      "restore_session",
    );
    expect(onRun).toHaveBeenLastCalledWith(actionCompleted);

    await controllerFor(actionCompleted, onRun).resume();
    expect(apiMocks.resumeHumanControl).toHaveBeenCalledWith(
      "run-handoff",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(onRun).toHaveBeenLastCalledWith(revalidating);

    apiMocks.resumeHumanControl.mockClear();
    await controllerFor(revalidating, onRun).resume();
    expect(apiMocks.resumeHumanControl).not.toHaveBeenCalled();
  });
});
