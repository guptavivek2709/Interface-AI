import { describe, expect, it } from "vitest";
import { compileArtifactV2, type ArtifactCompilerV2Recipe } from "../../src/discovery/artifactCompilerV2.js";
import { projectDiscoveryTraceV2 } from "../../src/discovery/discoveryTraceV2.js";
import type { DiscoverySuccess } from "../../src/discovery/discoveryRunner.js";
import type { ObservedSemanticTarget } from "../../src/surface/types.js";

const SHARE_ID = "100234-S0070";

function semanticDiscovery(): DiscoverySuccess {
  const rowControl: ObservedSemanticTarget = {
    ref: "s1",
    framePath: [],
    kind: "table_row_control",
    name: "Select for Share ID",
    headers: ["Share ID", "Type", "Balance", "Status", "Action"],
    keyColumn: "Share ID",
    keyInputName: "share_id",
    controlRole: "link",
    controlName: "Select",
  };
  const rowValue: ObservedSemanticTarget = {
    ref: "s4",
    framePath: [],
    kind: "table_row_value",
    name: "Status for share_id",
    headers: ["Share ID", "Type", "Balance", "Status", "Action"],
    keyColumn: "Share ID",
    keyInputName: "share_id",
    valueColumn: "Status",
  };
  const labelValue: ObservedSemanticTarget = {
    ref: "s2",
    framePath: [],
    kind: "label_value",
    name: "Member name value",
    label: "Member name",
    valueCellOffset: 1,
  };
  const table: ObservedSemanticTarget = {
    ref: "s3",
    framePath: [],
    kind: "table",
    name: "Table: Share ID, Type, Balance, Status",
    headers: ["Share ID", "Type", "Balance", "Status"],
  };
  const entry = (
    step: number,
    action: DiscoverySuccess["journal"][number]["action"],
    target: ObservedSemanticTarget,
  ): DiscoverySuccess["journal"][number] => ({
    step,
    plannerReason: "privacy-excluded",
    plannerProvider: "anthropic-messages",
    plannerModel: "claude-sonnet-5",
    plannerResponseId: `response-${step}`,
    plannerLatencyMs: 1,
    action,
    risk: "safe",
    target,
    beforeStateHash: `before-${step}`,
    afterStateHash: `after-${step}`,
    beforeHeadings: ["Member shares"],
    afterHeadings: ["Member shares"],
    result: "completed",
  });
  return {
    kind: "success",
    runId: "semantic-discovery",
    goal: `Select share ${SHARE_ID} and return member name and share balances`,
    sessionId: "excluded",
    sessionRef: "e".repeat(64),
    planner: { provider: "anthropic-messages", model: "claude-sonnet-5", callCount: 4 },
    checkpointText: "Member shares",
    outputs: {},
    journal: [
      entry(1, { kind: "click", targetRef: "s1", value: null, outputName: null, outputType: null, key: null }, rowControl),
      entry(2, { kind: "extract", targetRef: "s2", value: null, outputName: "member_name", outputType: "string", key: null }, labelValue),
      entry(3, { kind: "extract", targetRef: "s4", value: null, outputName: "share_status", outputType: "string", key: null }, rowValue),
      entry(4, { kind: "extract", targetRef: "s3", value: null, outputName: "shares", outputType: "table", key: null }, table),
    ],
    finalObservation: {
      capturedAt: "2026-08-20T20:00:00.000Z",
      url: "https://meridian.example/shares",
      title: "Member shares",
      httpStatus: 200,
      controls: [],
      semanticTargets: [rowControl, rowValue, labelValue, table],
      frames: [{ framePath: [], url: "https://meridian.example/shares", title: "Member shares", headings: ["Member shares"], visibleText: "" }],
      visibleText: "",
      stateHash: "final",
      screenshotPath: "excluded.png",
    },
  };
}

describe("semantic discovery V2 compilation", () => {
  it("persists symbolic row keys and compiles reviewer-typed tables", () => {
    const trace = projectDiscoveryTraceV2(semanticDiscovery(), {
      inputs: { share_id: SHARE_ID },
      plannerMode: "model",
    });
    const recipe: ArtifactCompilerV2Recipe = {
      capability: {
        id: "member.share_semantics",
        name: "Read member share semantics",
        description: "Selects one exact share row and returns reviewed member data.",
        version: "1.0.0",
        risk: "read",
        tags: ["meridian", "discovery"],
      },
      compatibility: {
        surfaceAdapter: "playwright-web-meridian-v2",
        vendorProduct: "Meridian Core",
        appVersion: "4.2.1",
        entryPoint: "https://meridian.example/menu",
      },
      inputs: [{
        name: "share_id",
        description: "Exact selected share identifier.",
        type: { kind: "string", format: "share_id" },
        required: true,
        classification: "restricted",
      }],
      outputs: [
        {
          name: "member_name",
          description: "Member name.",
          type: { kind: "string" },
          classification: "confidential",
        },
        {
          name: "shares",
          description: "Share balances.",
          type: {
            kind: "array",
            items: {
              kind: "object",
              properties: {
                share_id: { kind: "string", format: "share_id" },
                balance: { kind: "money", currency: "USD" },
              },
              required: ["share_id", "balance"],
            },
          },
          classification: "restricted",
        },
        {
          name: "share_status",
          description: "Status of the exact selected share.",
          type: { kind: "string" },
          classification: "internal",
        },
      ],
      policy: {
        routes: [{ origin: "https://meridian.example", pathPattern: "^/.*$", methods: ["GET"] }],
        allowedActions: ["click", "extract", "extract_table"],
        maxEffect: "read",
        inputRelations: [],
      },
      runtimeStates: [],
      stepAnnotations: Object.fromEntries(trace.steps.map((step) => [step.id, { effect: "read" as const }])),
      tableColumns: {
        shares: [
          { header: "Share ID", key: "share_id", type: { kind: "string", format: "share_id" }, classification: "restricted" },
          { header: "Balance", key: "balance", type: { kind: "money", currency: "USD" }, classification: "restricted" },
        ],
      },
    };

    const artifact = compileArtifactV2(trace, recipe, { forbiddenInputValues: [SHARE_ID] });
    expect(JSON.stringify(trace)).not.toContain(SHARE_ID);
    expect(artifact.targets.find((target) => target.strategies[0]?.kind === "table_row_control")?.strategies[0]).toMatchObject({
      kind: "table_row_control",
      key: { kind: "input", name: "share_id" },
    });
    expect(artifact.targets.find((target) => target.strategies[0]?.kind === "table_row_value")?.strategies[0]).toMatchObject({
      kind: "table_row_value",
      key: { kind: "input", name: "share_id" },
      valueColumn: "Status",
    });
    expect(artifact.steps[3]?.action).toMatchObject({
      kind: "extract_table",
      outputName: "shares",
      columns: [
        { header: "Share ID", key: "share_id" },
        { header: "Balance", key: "balance" },
      ],
    });
  });
});
