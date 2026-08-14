import type { ObservedControl } from "../surface/types.js";
import {
  type Planner,
  type PlannerAction,
  type PlannerRequest,
  type PlannerResponse,
} from "./planner.js";

function actionResponse(action: PlannerAction, reason: string): PlannerResponse {
  return {
    decision: {
      decision: "act",
      reason,
      action,
      checkpointText: null,
      escalationReason: null,
    },
    metadata: {
      provider: "scripted-offline-test-double",
      model: "none",
      responseId: null,
      latencyMs: 0,
    },
  };
}

function find(controls: ObservedControl[], name: string): ObservedControl | undefined {
  return controls.find((control) => control.name.toLowerCase() === name.toLowerCase());
}

function inputValue(name: string) {
  return { kind: "input" as const, name, value: null };
}

export class ScriptedPlanner implements Planner {
  readonly name = "scripted-offline-test-double";
  readonly model = "none";

  async decide(request: PlannerRequest): Promise<PlannerResponse> {
    const controls = request.observation.controls;
    const history = request.history;
    const actedOn = (targetName: string) =>
      history.some((entry) => entry.targetName?.toLowerCase() === targetName.toLowerCase());
    const extracted = (outputName: string) =>
      history.some((entry) => entry.outputName === outputName);

    const memberNumber = find(controls, "Member number");
    if (memberNumber && !actedOn("Member number")) {
      return actionResponse(
        {
          kind: "fill",
          targetRef: memberNumber.ref,
          value: inputValue("memberId"),
          outputName: null,
          outputType: null,
          key: null,
        },
        "Enter the caller-supplied member identifier.",
      );
    }
    const search = find(controls, "Search");
    if (search) {
      return actionResponse(
        {
          kind: "click",
          targetRef: search.ref,
          value: null,
          outputName: null,
          outputType: null,
          key: null,
        },
        "Search for the member after entering the identifier.",
      );
    }
    const open = find(controls, "Open sub-account");
    if (open) {
      return actionResponse(
        {
          kind: "click",
          targetRef: open.ref,
          value: null,
          outputName: null,
          outputType: null,
          key: null,
        },
        "Open the reversible sub-account setup flow.",
      );
    }

    const accountType = find(controls, "Account type");
    if (accountType && !actedOn("Account type")) {
      return actionResponse(
        {
          kind: "select",
          targetRef: accountType.ref,
          value: inputValue("accountType"),
          outputName: null,
          outputType: null,
          key: null,
        },
        "Choose the requested account type.",
      );
    }
    const nickname = find(controls, "Nickname");
    if (nickname && !actedOn("Nickname")) {
      return actionResponse(
        {
          kind: "fill",
          targetRef: nickname.ref,
          value: inputValue("nickname"),
          outputName: null,
          outputType: null,
          key: null,
        },
        "Enter the caller-supplied nickname.",
      );
    }
    const deposit = find(controls, "Initial deposit");
    if (deposit && !actedOn("Initial deposit")) {
      return actionResponse(
        {
          kind: "fill",
          targetRef: deposit.ref,
          value: inputValue("initialDeposit"),
          outputName: null,
          outputType: null,
          key: null,
        },
        "Enter the caller-supplied opening amount.",
      );
    }
    const review = find(controls, "Review sub-account");
    if (review) {
      return actionResponse(
        {
          kind: "click",
          targetRef: review.ref,
          value: null,
          outputName: null,
          outputType: null,
          key: null,
        },
        "Proceed to the non-committing review checkpoint.",
      );
    }

    const outputs: Array<[string, string, "string" | "money"]> = [
      ["memberName", "Member name", "string"],
      ["memberId", "Member number", "string"],
      ["accountType", "Account type", "string"],
      ["nickname", "Nickname", "string"],
      ["initialDeposit", "Initial deposit", "money"],
    ];
    for (const [outputName, label, outputType] of outputs) {
      const control = find(controls, label);
      if (control && !extracted(outputName)) {
        return actionResponse(
          {
            kind: "extract",
            targetRef: control.ref,
            value: null,
            outputName,
            outputType,
            key: null,
          },
          `Extract the declared ${outputName} output from the review screen.`,
        );
      }
    }

    if (request.observation.visibleText.toLowerCase().includes("review sub-account")) {
      return {
        decision: {
          decision: "finish",
          reason: "The review checkpoint is visible and all outputs were extracted.",
          action: null,
          checkpointText: "Review sub-account",
          escalationReason: null,
        },
        metadata: {
          provider: this.name,
          model: this.model,
          responseId: null,
          latencyMs: 0,
        },
      };
    }

    return {
      decision: {
        decision: "escalate",
        reason: "No safe scripted action matches the current observed state.",
        action: null,
        checkpointText: null,
        escalationReason: "UNRECOGNIZED_STATE",
      },
      metadata: {
        provider: this.name,
        model: this.model,
        responseId: null,
        latencyMs: 0,
      },
    };
  }
}
