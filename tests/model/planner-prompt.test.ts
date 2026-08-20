import { describe, expect, it } from "vitest";
import { plannerPrompt, type PlannerRequest } from "../../src/model/planner.js";

describe("plannerPrompt", () => {
  it("exposes symbolic input names and types without sending invocation values", () => {
    const canaryMember = "SENSITIVE_MEMBER_CANARY_419";
    const canaryNickname = "Sensitive Nickname Canary 731";
    const request: PlannerRequest = {
      goal: `Use ${canaryMember} and ${canaryNickname} to reach review.`,
      inputs: { memberId: canaryMember, nickname: canaryNickname, enabled: true, count: 2 },
      history: [
        {
          step: 1,
          decision: "act",
          actionKind: "fill",
          targetName: canaryMember,
          outputName: null,
          result: `Filled ${canaryNickname}`,
        },
      ],
      maxSteps: 24,
      currentStep: 1,
      observation: {
        capturedAt: "2026-08-19T00:00:00.000Z",
        url: "http://127.0.0.1:4317/",
        title: "Synthetic bank",
        controls: [
          {
            ref: "control-1",
            framePath: [{ title: `Workspace ${canaryMember}`, url: "http://example.test" }],
            role: "textbox",
            name: `Member ${canaryMember}`,
            tag: "input",
            label: `Nickname ${canaryNickname}`,
            nameAttribute: "memberId",
            text: null,
            value: canaryNickname,
            disabled: false,
          },
        ],
        frames: [
          {
            framePath: [{ title: canaryMember, url: "http://example.test" }],
            url: `http://example.test/?member=${encodeURIComponent(canaryMember)}&nickname=${new URLSearchParams([["value", canaryNickname]]).toString().slice("value=".length)}`,
            title: "Workspace",
            headings: [`Member ${canaryMember}`],
            visibleText: `Review ${canaryNickname}`,
          },
        ],
        visibleText: "Member search",
        stateHash: "abc",
        screenshotPath: "observation.png",
      },
    };

    const prompt = plannerPrompt(request);
    expect(prompt).not.toContain(canaryMember);
    expect(prompt).not.toContain(canaryNickname);
    expect(prompt).not.toContain(encodeURIComponent(canaryNickname));
    expect(prompt).not.toContain("Sensitive+Nickname+Canary+731");
    expect(prompt).toContain("{{memberId}}");
    expect(prompt).toContain("{{nickname}}");
    expect(prompt).toContain('"name":"memberId","type":"string"');
    expect(prompt).toContain('"name":"enabled","type":"boolean"');
    expect(prompt).toContain('"name":"count","type":"number"');
    expect(prompt).toContain("values withheld");
  });
});
