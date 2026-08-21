import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Capability, RunRecord } from "../types";
import { ExecutionBindingStrip, resolveExecutionBinding } from "./RunDetail";

const artifactDigest = "a".repeat(64);
const targetProfileDigest = "b".repeat(64);
const discoveryRunId = "discovery.11111111-1111-4111-8111-111111111111";

const capability: Capability = {
  id: "funds.transfer",
  name: "Transfer funds",
  description: "Transfer funds after review.",
  version: "2.0.0",
  schemaVersion: "2.0",
  approval: "approved",
  risk: "write",
  tags: [],
  inputs: [],
  outputs: [],
  digest: artifactDigest,
  targetProfileDigest,
  contractValid: true,
  supportsSupervisorHandoff: false,
  lineage: {
    lineageId: "lineage.funds.transfer",
    discoveryRunId,
    provider: "anthropic-messages",
    model: "claude-sonnet-5",
    traceDigest: "c".repeat(64),
    draftDigest: "d".repeat(64),
    reviewedDigest: "e".repeat(64),
    approvedDigest: artifactDigest,
    canaryRunId: "canary.22222222-2222-4222-8222-222222222222",
  },
};

const run: RunRecord = {
  id: "run-binding",
  capabilityId: capability.id,
  capabilityVersion: capability.version,
  artifactDigest,
  targetProfileDigest,
  phase: "running",
  journal: [],
  incidents: [],
};

describe("execution binding strip", () => {
  it("renders only the exact validated replay binding and discovery lineage", () => {
    expect(resolveExecutionBinding(run, capability)).toEqual({
      version: "2.0.0",
      artifactDigest,
      targetProfileDigest,
      discoveryRunId,
    });
    const html = renderToStaticMarkup(<ExecutionBindingStrip run={run} capability={capability} />);
    expect(html).toContain("Execution binding");
    expect(html).toContain("2.0.0");
    expect(html).toContain(artifactDigest);
    expect(html).toContain(targetProfileDigest);
    expect(html).toContain(discoveryRunId);
    expect(html).not.toContain("Unavailable");
  });

  it("fails closed when the supplied capability does not match the run", () => {
    const mismatched = { ...capability, digest: "f".repeat(64) };
    expect(resolveExecutionBinding(run, mismatched)).toEqual({
      version: null,
      artifactDigest: null,
      targetProfileDigest: null,
      discoveryRunId: null,
    });
    const html = renderToStaticMarkup(<ExecutionBindingStrip run={run} capability={mismatched} />);
    expect(html.match(/Unavailable/g)).toHaveLength(4);
    expect(html).not.toContain(artifactDigest);
    expect(html).not.toContain(discoveryRunId);
  });
});
