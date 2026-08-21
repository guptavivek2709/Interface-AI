import { describe, expect, it } from "vitest";
import { canonicalArtifactDigest } from "../../src/catalog/index.js";
import {
  compileArtifactV2,
  type ArtifactCompilerV2Recipe,
} from "../../src/discovery/artifactCompilerV2.js";
import {
  ArtifactPromotionError,
  approveDiscoveredArtifactV2,
  createArtifactLineageV2,
  recordArtifactCanaryPassedV2,
  reviewDiscoveredArtifactV2,
} from "../../src/discovery/artifactPromotionV2.js";
import {
  projectDiscoveryTraceV2,
  type DiscoveryTraceV2,
} from "../../src/discovery/discoveryTraceV2.js";
import type { DiscoverySuccess } from "../../src/discovery/discoveryRunner.js";
import type { CapabilityArtifactV2 } from "../../src/domain/index.js";

const RAW_MEMBER = "100234";

function control(options: {
  ref: string;
  role: "button" | "textbox" | "status";
  name: string;
  label?: string;
  nameAttribute?: string;
  text?: string;
}) {
  return {
    ref: options.ref,
    framePath: [],
    role: options.role,
    name: options.name,
    tag: options.role === "button" ? "button" : "input",
    label: options.label ?? null,
    nameAttribute: options.nameAttribute ?? null,
    text: options.text ?? null,
    value: "",
    disabled: false,
  } as const;
}

function discovery(): DiscoverySuccess {
  const memberField = control({
    ref: "c1",
    role: "textbox",
    name: `Member ${RAW_MEMBER}`,
    label: "Member number",
    nameAttribute: "member_number",
  });
  const search = control({ ref: "c2", role: "button", name: "Search", text: "Search" });
  const memberName = control({
    ref: "c3",
    role: "status",
    name: "Member name",
    nameAttribute: "member_name",
  });
  return {
    kind: "success",
    runId: "meridian-balance-discovery",
    goal: `Look up member ${RAW_MEMBER} and return the member name`,
    sessionId: "not-persisted-session",
    sessionRef: "f".repeat(64),
    planner: { provider: "anthropic-messages", model: "claude-sonnet-5", callCount: 4 },
    checkpointText: "Member record",
    outputs: { member_name: "Synthetic Person" },
    journal: [
      {
        step: 1,
        plannerReason: `Enter ${RAW_MEMBER}`,
        plannerProvider: "anthropic-messages",
        plannerModel: "claude-sonnet-5",
        plannerResponseId: "response-1",
        plannerLatencyMs: 10,
        action: {
          kind: "fill",
          targetRef: "c1",
          // The projector repairs an exact literal/input match without persisting the literal.
          value: { kind: "literal", name: null, value: RAW_MEMBER },
          outputName: null,
          outputType: null,
          key: null,
        },
        risk: "safe",
        target: memberField,
        beforeStateHash: "before-fill",
        afterStateHash: "after-fill",
        beforeHeadings: ["Member search"],
        afterHeadings: ["Member search"],
        result: "completed",
      },
      {
        step: 2,
        plannerReason: "Submit the exact member search",
        plannerProvider: "anthropic-messages",
        plannerModel: "claude-sonnet-5",
        plannerResponseId: "response-2",
        plannerLatencyMs: 10,
        action: {
          kind: "click",
          targetRef: "c2",
          value: null,
          outputName: null,
          outputType: null,
          key: null,
        },
        risk: "safe",
        target: search,
        beforeStateHash: "before-search",
        afterStateHash: "after-search",
        beforeHeadings: ["Member search"],
        afterHeadings: ["Member record"],
        result: "completed",
      },
      {
        step: 3,
        plannerReason: "Extract the requested output",
        plannerProvider: "anthropic-messages",
        plannerModel: "claude-sonnet-5",
        plannerResponseId: "response-3",
        plannerLatencyMs: 10,
        action: {
          kind: "extract",
          targetRef: "c3",
          value: null,
          outputName: "member_name",
          outputType: "string",
          key: null,
        },
        risk: "safe",
        target: memberName,
        beforeStateHash: "before-extract",
        afterStateHash: "after-extract",
        beforeHeadings: ["Member record"],
        afterHeadings: ["Member record"],
        result: "completed",
        outputValue: "Synthetic Person",
      },
    ],
    finalObservation: {
      capturedAt: "2026-08-20T20:00:00.000Z",
      url: `https://meridian.example/members/${RAW_MEMBER}`,
      title: "Member Record - Meridian Core",
      httpStatus: 200,
      controls: [memberName],
      frames: [
        {
          framePath: [],
          url: `https://meridian.example/members/${RAW_MEMBER}`,
          title: "Member Record - Meridian Core",
          headings: ["Member record"],
          visibleText: `Member ${RAW_MEMBER}`,
        },
      ],
      visibleText: `Member ${RAW_MEMBER}`,
      stateHash: "final-state",
      screenshotPath: `C:/sensitive/${RAW_MEMBER}.png`,
    },
  };
}

function project(mode: "model" | "test_double" = "model"): DiscoveryTraceV2 {
  return projectDiscoveryTraceV2(discovery(), {
    inputs: { member_number: RAW_MEMBER },
    plannerMode: mode,
  });
}

function recipe(trace: DiscoveryTraceV2): ArtifactCompilerV2Recipe {
  return {
    capability: {
      id: "member.lookup_discovered",
      name: "Look up a discovered member",
      description: "Read one member name through the discovered path.",
      version: "2.1.0",
      risk: "read",
      tags: ["meridian", "discovery"],
    },
    compatibility: {
      surfaceAdapter: "playwright-web-meridian-v2",
      vendorProduct: "Meridian Core",
      appVersion: "4.2.1",
      entryPoint: "https://meridian.example/menu",
    },
    inputs: [
      {
        name: "member_number",
        description: "Six-digit member number.",
        type: { kind: "string", format: "member_number", pattern: "^[0-9]{6}$" },
        required: true,
        classification: "restricted",
      },
    ],
    outputs: [
      {
        name: "member_name",
        description: "Selected member name.",
        type: { kind: "string" },
        classification: "confidential",
      },
    ],
    policy: {
      routes: [
        { origin: "https://meridian.example", pathPattern: "^/menu$", methods: ["GET"] },
        { origin: "https://meridian.example", pathPattern: "^/members$", methods: ["GET"] },
        {
          origin: "https://meridian.example",
          pathPattern: "^/members/[0-9]{6}$",
          methods: ["GET"],
        },
      ],
      allowedActions: ["fill", "click", "extract"],
      maxEffect: "read",
      inputRelations: [],
    },
    runtimeStates: [],
    stepAnnotations: Object.fromEntries(
      trace.steps.map((step) => [step.id, { effect: "read" as const }]),
    ),
  };
}

function compile(trace = project()): CapabilityArtifactV2 {
  return compileArtifactV2(trace, recipe(trace), { forbiddenInputValues: [RAW_MEMBER] });
}

function reviewedLineage(trace: DiscoveryTraceV2, draft: CapabilityArtifactV2) {
  const lineage = createArtifactLineageV2(trace, draft, {
    forbiddenInputValues: [RAW_MEMBER],
    createdAt: "2026-08-20T20:01:00.000Z",
  });
  return reviewDiscoveredArtifactV2(lineage, draft, draft, {
    reviewer: "reviewer-1",
    reviewedAt: "2026-08-20T20:02:00.000Z",
    forbiddenInputValues: [RAW_MEMBER],
  });
}

describe("discovery-to-V2 trace and compiler", () => {
  it("projects a privacy-safe trace and derives the executable draft from it", () => {
    const trace = project();
    const serializedTrace = JSON.stringify(trace);

    expect(serializedTrace).not.toContain(RAW_MEMBER);
    expect(serializedTrace).not.toContain("Synthetic Person");
    expect(serializedTrace).not.toContain("not-persisted-session");
    expect(serializedTrace).not.toContain("C:/sensitive");
    expect(trace.goalTemplate).toBe("Look up member {{member_number}} and return the member name");
    expect(trace.steps[0]!.action).toMatchObject({
      kind: "fill",
      value: { kind: "input", name: "member_number" },
    });

    const artifact = compile(trace);
    expect(artifact.capability.approval).toBe("draft");
    expect(artifact.provenance).toMatchObject({
      source: "discovery",
      discoveryRunId: trace.runId,
      planner: { provider: "anthropic-messages", model: "claude-sonnet-5" },
    });
    expect(artifact.steps.map((step) => step.action.kind)).toEqual(["fill", "click", "extract"]);
    expect(artifact.targets.some((target) => target.strategies.some((strategy) => strategy.kind === "label"))).toBe(true);
    expect(JSON.stringify(artifact)).not.toContain(RAW_MEMBER);
  });

  it("requires reviewer annotations for every discovered step", () => {
    const trace = project();
    const incomplete = recipe(trace);
    delete (incomplete.stepAnnotations as Record<string, unknown>)[trace.steps[1]!.id];

    expect(() =>
      compileArtifactV2(trace, incomplete, { forbiddenInputValues: [RAW_MEMBER] }),
    ).toThrow(/must match the trace exactly/u);
  });

  it("retains a public form-name locator when a demo value equals its input name", () => {
    const source = discovery();
    const passwordField = control({
      ref: "password-control",
      role: "textbox",
      name: "password",
      nameAttribute: "password",
    });
    const trace = projectDiscoveryTraceV2(
      {
        ...source,
        goal: "Fill {{password}} in the password field",
        outputs: {},
        journal: [{
          ...source.journal[0]!,
          action: {
            kind: "fill",
            targetRef: passwordField.ref,
            value: { kind: "input", name: "password", value: null },
            outputName: null,
            outputType: null,
            key: null,
          },
          target: passwordField,
        }],
      },
      { inputs: { password: "password" }, plannerMode: "model" },
    );

    expect(trace.steps[0]!.target?.strategies).toContainEqual({
      kind: "name",
      name: "password",
    });
  });
});

describe("external artifact promotion lineage", () => {
  it("binds draft, review, canary, and approval with canonical digests", () => {
    const trace = project();
    const draft = compile(trace);
    const reviewed = reviewedLineage(trace, draft);
    const reviewedDigest = canonicalArtifactDigest(draft);
    const canaryPassed = recordArtifactCanaryPassedV2(
      reviewed,
      draft,
      {
        status: "passed",
        artifactDigest: reviewedDigest,
        canaryRunId: "canary-1",
        evidenceDigest: "a".repeat(64),
        completedAt: "2026-08-20T20:03:00.000Z",
      },
      { forbiddenInputValues: [RAW_MEMBER] },
    );
    const approved = approveDiscoveredArtifactV2(canaryPassed, draft, {
      approver: "approver-1",
      approvedAt: "2026-08-20T20:04:00.000Z",
      forbiddenInputValues: [RAW_MEMBER],
    });

    expect(approved.artifact.capability.approval).toBe("approved");
    expect(approved.lineage.stage).toBe("approved");
    expect(approved.lineage.approvedDigest).toBe(canonicalArtifactDigest(approved.artifact));
    expect(approved.lineage.events.at(-1)).toMatchObject({
      type: "approved",
      parentArtifactDigest: reviewedDigest,
      artifactDigest: approved.lineage.approvedDigest,
    });
  });

  it("rejects skipped stages, failed or mismatched canaries, and test-double promotion", () => {
    const trace = project();
    const draft = compile(trace);
    const initial = createArtifactLineageV2(trace, draft, { forbiddenInputValues: [RAW_MEMBER] });

    expect(() =>
      recordArtifactCanaryPassedV2(initial, draft, {
        status: "passed",
        artifactDigest: canonicalArtifactDigest(draft),
        canaryRunId: "skipped-review",
        evidenceDigest: "b".repeat(64),
        completedAt: "2026-08-20T20:03:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_STAGE" }));

    const reviewed = reviewDiscoveredArtifactV2(initial, draft, draft, { reviewer: "reviewer-1" });
    expect(() =>
      recordArtifactCanaryPassedV2(reviewed, draft, {
        status: "failed",
        artifactDigest: canonicalArtifactDigest(draft),
        canaryRunId: "failed-canary",
        evidenceDigest: "c".repeat(64),
        completedAt: "2026-08-20T20:03:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "CANARY_FAILED" }));
    expect(() =>
      recordArtifactCanaryPassedV2(reviewed, draft, {
        status: "passed",
        artifactDigest: "d".repeat(64),
        canaryRunId: "wrong-digest",
        evidenceDigest: "e".repeat(64),
        completedAt: "2026-08-20T20:03:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "DIGEST_MISMATCH" }));

    const testTrace = project("test_double");
    const testDraft = compile(testTrace);
    const testReviewed = reviewedLineage(testTrace, testDraft);
    const testCanary = recordArtifactCanaryPassedV2(testReviewed, testDraft, {
      status: "passed",
      artifactDigest: canonicalArtifactDigest(testDraft),
      canaryRunId: "test-double-canary",
      evidenceDigest: "f".repeat(64),
      completedAt: "2026-08-20T20:03:00.000Z",
    });
    expect(() =>
      approveDiscoveredArtifactV2(testCanary, testDraft, { approver: "approver-1" }),
    ).toThrowError(expect.objectContaining({ code: "TEST_DOUBLE_FORBIDDEN" }));
  });

  it("rejects raw discovery inputs introduced during human review", () => {
    const trace = project();
    const draft = compile(trace);
    const lineage = createArtifactLineageV2(trace, draft, { forbiddenInputValues: [RAW_MEMBER] });
    const leaked = structuredClone(draft);
    leaked.capability.description = `Reviewed lookup for ${RAW_MEMBER}`;

    expect(() =>
      reviewDiscoveredArtifactV2(lineage, draft, leaked, {
        reviewer: "reviewer-1",
        forbiddenInputValues: [RAW_MEMBER],
      }),
    ).toThrowError(ArtifactPromotionError);
    try {
      reviewDiscoveredArtifactV2(lineage, draft, leaked, {
        reviewer: "reviewer-1",
        forbiddenInputValues: [RAW_MEMBER],
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "INPUT_LEAK" });
    }
  });
});
