import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDemoServer, type DemoServer } from "../../src/demo/index.js";
import { DiscoveryRunner } from "../../src/discovery/discoveryRunner.js";
import { EventRecorder } from "../../src/evidence/event-recorder.js";
import { performDemoOperatorHandoff } from "../../src/handoff/operatorServer.js";
import { ScriptedPlanner } from "../../src/model/scriptedPlanner.js";
import type { Planner } from "../../src/model/planner.js";
import { PolicyEngine } from "../../src/safety/policy.js";
import { Redactor } from "../../src/safety/redactor.js";
import { PlaywrightSurface } from "../../src/surface/playwright/playwrightSurface.js";

describe("discovery vertical slice", () => {
  let demo: DemoServer | undefined;
  let scratch: string | undefined;
  let surface: PlaywrightSurface | undefined;
  let recorder: EventRecorder | undefined;

  afterEach(async () => {
    await recorder?.close();
    await surface?.close();
    await demo?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("drives the live legacy UI and records a parameterized successful journal", async () => {
    demo = await startDemoServer();
    scratch = await mkdtemp(path.join(tmpdir(), "capability-discovery-test-"));
    const redactor = new Redactor();
    const policy = new PolicyEngine({
      allowedRoutes: [{ origin: demo.baseUrl, path: "/", match: "prefix" }],
      allowedActions: ["click", "fill", "select", "extract", "press"],
      deniedActions: ["download", "upload", "create", "submit"],
      maxRisk: "high",
    });
    recorder = await EventRecorder.create({
      filePath: path.join(scratch, "discovery.jsonl"),
      runId: "discovery-test",
      redactor,
      runMetadata: { mode: "test" },
      syncEachWrite: false,
    });
    surface = new PlaywrightSurface({
      observationDirectory: path.join(scratch, "observations"),
      assertNavigationAllowed: (url, kind) => {
        policy.assertNavigationAllowed({ url, kind });
      },
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    await surface.start(`${demo.baseUrl}/?tenant=summit`);
    const result = await new DiscoveryRunner({
      surface,
      planner: new ScriptedPlanner(),
      policy,
      recorder,
      redactor,
      goal:
        "Look up member {{memberId}}, prepare a {{accountType}} sub-account named {{nickname}} with {{initialDeposit}}, stop at Review ready, and return exactly memberName, memberId, accountType, nickname, and initialDeposit.",
      inputs: {
        memberId: "MBR-1001",
        accountType: "Savings",
        nickname: "Rainy Day",
        initialDeposit: "250.00",
      },
    }).run();

    expect(result.kind, JSON.stringify(result, null, 2)).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs).toEqual({
      memberName: "Elena Torres",
      memberId: "MBR-1001",
      accountType: "Savings",
      nickname: "Rainy Day",
      initialDeposit: "$250.00",
    });
    expect(result.journal.some((entry) => entry.action.value?.kind === "input")).toBe(true);
    expect(result.finalObservation.visibleText).toContain("Review ready");
    expect(result.planner.callCount).toBeGreaterThan(5);

    await recorder.flush();
    const log = await readFile(path.join(scratch, "discovery.jsonl"), "utf8");
    expect(log).not.toContain("MBR-1001");
    expect(log).not.toContain("Rainy Day");
    expect(log).toContain("scripted-offline-test-double");
  });

  it("escalates an unrecognized state to a human in the same discovery session and resumes", async () => {
    demo = await startDemoServer();
    scratch = await mkdtemp(path.join(tmpdir(), "capability-discovery-handoff-test-"));
    const redactor = new Redactor();
    const policy = new PolicyEngine({
      allowedRoutes: [{ origin: demo.baseUrl, path: "/", match: "prefix" }],
      allowedActions: ["click", "fill", "select", "extract", "press"],
      maxRisk: "high",
    });
    recorder = await EventRecorder.create({
      filePath: path.join(scratch, "discovery.jsonl"),
      runId: "discovery-handoff-test",
      redactor,
      syncEachWrite: false,
    });
    surface = new PlaywrightSurface({
      observationDirectory: path.join(scratch, "observations"),
      assertNavigationAllowed: (url, kind) => policy.assertNavigationAllowed({ url, kind }),
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    await surface.start(`${demo.baseUrl}/?tenant=summit`);
    const sessionId = surface.sessionId;
    const result = await new DiscoveryRunner({
      surface,
      planner: new ScriptedPlanner(),
      policy,
      recorder,
      redactor,
      goal: "Prepare the safe review flow and return its summary.",
      inputs: {
        memberId: "HANDOFF-1001",
        accountType: "Savings",
        nickname: "Recovered",
        initialDeposit: "25.00",
      },
      autoHandoff: performDemoOperatorHandoff,
    }).run();

    expect(result.kind, JSON.stringify(result, null, 2)).toBe("success");
    await recorder.flush();
    const log = await readFile(path.join(scratch, "discovery.jsonl"), "utf8");
    expect(log).toContain('"intervention.requested"');
    expect(log).toContain('"human.action.completed"');
    expect(log).toContain('"handoff.reconciled"');
    expect(log).not.toContain(sessionId);
    expect(log).toContain('"sessionId":"[REDACTED]"');
  });

  it("grounds a verbose model checkpoint in an exact visible heading", async () => {
    demo = await startDemoServer();
    scratch = await mkdtemp(path.join(tmpdir(), "capability-checkpoint-grounding-test-"));
    const redactor = new Redactor();
    const policy = new PolicyEngine({
      allowedRoutes: [{ origin: demo.baseUrl, path: "/", match: "prefix" }],
      allowedActions: ["click", "fill", "select", "extract", "press"],
      maxRisk: "high",
    });
    recorder = await EventRecorder.create({
      filePath: path.join(scratch, "discovery.jsonl"),
      runId: "checkpoint-grounding-test",
      redactor,
      syncEachWrite: false,
    });
    surface = new PlaywrightSurface({
      observationDirectory: path.join(scratch, "observations"),
      assertNavigationAllowed: (url, kind) => policy.assertNavigationAllowed({ url, kind }),
      assertResourceAllowed: (url) => policy.assertResourceAllowed(url),
    });
    await surface.start(`${demo.baseUrl}/?tenant=summit`);
    const base = new ScriptedPlanner();
    const planner: Planner = {
      name: "verbose-checkpoint-test-double",
      model: "none",
      decide: async (request) => {
        const response = await base.decide(request);
        if (response.decision.decision === "finish") {
          response.decision.checkpointText =
            "Review ready — Training boundary reached; no account was created.";
        }
        return response;
      },
    };
    const result = await new DiscoveryRunner({
      surface,
      planner,
      policy,
      recorder,
      redactor,
      goal: "Prepare the safe review and return its summary.",
      inputs: {
        memberId: "MBR-1001",
        accountType: "Savings",
        nickname: "Grounded",
        initialDeposit: "10.00",
      },
    }).run();
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.checkpointText).toBe("Review ready");
  });
});
