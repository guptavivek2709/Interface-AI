import { describe, expect, it } from "vitest";
import { compileArtifact } from "../../src/discovery/artifactCompiler.js";
import type { DiscoverySuccess } from "../../src/discovery/discoveryRunner.js";
import { createLegacyBankProfile } from "../../src/profiles/index.js";

function discovery(goal: string, literal: string): DiscoverySuccess {
  const capturedAt = "2026-08-13T12:00:00.000Z";
  return {
    kind: "success",
    runId: "privacy-compiler-run",
    goal,
    sessionId: "session-1",
    sessionRef: "a".repeat(64),
    planner: { provider: "test", model: "test", callCount: 1 },
    checkpointText: "Review ready",
    outputs: {},
    journal: [
      {
        step: 1,
        plannerReason: "test",
        plannerProvider: "test",
        plannerModel: "test",
        plannerResponseId: null,
        plannerLatencyMs: 1,
        action: {
          kind: "fill",
          targetRef: "c1",
          value: { kind: "literal", name: null, value: literal },
          outputName: null,
          outputType: null,
          key: null,
        },
        risk: "reversible",
        target: {
          ref: "c1",
          framePath: [{ title: "Core banking workspace", url: "http://127.0.0.1:4317/workspace" }],
          role: "textbox",
          name: "Member number",
          tag: "input",
          label: "Member number",
          nameAttribute: "memberNumber",
          text: null,
          value: "",
          disabled: false,
        },
        beforeStateHash: "before",
        afterStateHash: "after",
        beforeHeadings: ["Member search"],
        afterHeadings: ["Review ready"],
        result: "completed",
      },
    ],
    finalObservation: {
      capturedAt,
      url: "http://127.0.0.1:4317/",
      title: "Demo",
      httpStatus: 200,
      controls: [],
      frames: [],
      visibleText: "Review ready",
      stateHash: "final",
      screenshotPath: "observation.png",
    },
  };
}

function compile(value: DiscoverySuccess) {
  const profile = createLegacyBankProfile("http://127.0.0.1:4317");
  return compileArtifact(value, {
    compatibility: {
      surfaceAdapter: profile.surfaceAdapter,
      vendorProduct: profile.id,
      entryPoint: profile.entryPoint,
    },
    policy: profile.policy,
    profile,
    sensitiveInvocationValues: ["MBR-1001"],
  });
}

describe("artifact compiler privacy boundary", () => {
  it("rejects a model literal copied from a sensitive invocation input", () => {
    expect(() => compile(discovery("Look up {{memberId}}", "MBR-1001"))).toThrow(
      /sensitive invocation value/u,
    );
  });

  it("rejects a provenance goal containing a sensitive invocation input", () => {
    expect(() => compile(discovery("Look up MBR-1001", "safe literal"))).toThrow(
      /provenance goal/u,
    );
  });
});
