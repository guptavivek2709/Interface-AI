import { describe, expect, it } from "vitest";
import { meridianArtifacts } from "../../src/capabilities/meridianArtifacts.js";
import { CapabilityArtifactV2Schema } from "../../src/domain/index.js";
import { integrateReviewedMeridianContractV2 } from "../../src/discovery/reviewedMeridianCandidateV2.js";

describe("integrateReviewedMeridianContractV2", () => {
  for (const reviewed of meridianArtifacts.filter((artifact) =>
    artifact.steps.some(
      (step) => step.effect === "reversible_write" || step.effect === "irreversible_commit",
    ))) {
    it(`keeps the discovered prefix and adds only the checked ${reviewed.capability.id} suffix`, () => {
      const boundary = reviewed.steps.findIndex(
        (step) => step.effect === "reversible_write" || step.effect === "irreversible_commit",
      );
      const prefix = structuredClone(reviewed.steps.slice(0, boundary));
      prefix[0] = { ...prefix[0]!, id: "trace.001.discovered" };
      const extracted = new Set(
        prefix
          .filter((step) => "outputName" in step.action)
          .map((step) => (step.action as { outputName: string }).outputName),
      );
      const draft = CapabilityArtifactV2Schema.parse({
        ...structuredClone(reviewed),
        capability: { ...reviewed.capability, approval: "draft" },
        provenance: {
          source: "discovery",
          createdAt: "2026-08-21T00:00:00.000Z",
          goal: "A model-observed safe prefix",
          discoveryRunId: `discovery.${reviewed.capability.id}`,
          planner: { provider: "anthropic-messages", model: "claude-sonnet-5" },
        },
        outputs: reviewed.outputs.filter((output) => extracted.has(output.name)),
        steps: prefix,
        checkpoint: prefix.at(-1)!.postcondition,
      });

      const candidate = integrateReviewedMeridianContractV2(draft);
      expect(candidate.provenance).toEqual(draft.provenance);
      expect(candidate.capability.approval).toBe("draft");
      expect(candidate.steps[0]!.id).toBe("trace.001.discovered");
      expect(candidate.steps.some((step) => step.effect === "reversible_write" || step.effect === "irreversible_commit")).toBe(true);
      expect(candidate.outputs).toEqual(reviewed.outputs);
      expect(candidate.checkpoint).toEqual(reviewed.checkpoint);
    });
  }

  it("keeps discovered read steps while restoring checked fault-only runtime controls", () => {
    const reviewed = meridianArtifacts.find(
      (artifact) => artifact.capability.id === "member.get_record_and_balances",
    )!;
    const checkedMenu = reviewed.targets.find((target) => target.id === "main_menu")!;
    const draft = CapabilityArtifactV2Schema.parse({
      ...structuredClone(reviewed),
      capability: { ...reviewed.capability, approval: "draft" },
      provenance: {
        source: "discovery",
        createdAt: "2026-08-21T00:00:00.000Z",
        goal: "Read balances",
        discoveryRunId: "discovery.balance",
        planner: { provider: "anthropic-messages", model: "claude-sonnet-5" },
      },
      targets: [
        ...reviewed.targets.filter((target) => target.id !== "maintenance_continue"),
        {
          ...structuredClone(checkedMenu),
          id: "trace.main_menu",
          strategies: [{ kind: "role", role: "link", name: "Main Menu", exact: true }],
        },
      ],
      steps: reviewed.steps.map((step, index) =>
        index === 0
          ? { ...structuredClone(step), action: { ...step.action, targetId: "trace.main_menu" } }
          : structuredClone(step)),
      runtimeStates: reviewed.runtimeStates.filter((state) => state.code !== "MAINTENANCE"),
    });
    const candidate = integrateReviewedMeridianContractV2(draft);
    expect(candidate.steps).toEqual(draft.steps);
    expect(candidate.runtimeStates).toEqual(reviewed.runtimeStates);
    expect(candidate.targets).toContainEqual(
      expect.objectContaining({ id: "maintenance_continue" }),
    );
    expect(
      candidate.targets.find((target) => target.id === "trace.main_menu")?.strategies,
    ).toContainEqual(expect.objectContaining({ kind: "navigation_link", name: "Main Menu" }));
    expect(candidate.provenance).toEqual(draft.provenance);
  });
});
