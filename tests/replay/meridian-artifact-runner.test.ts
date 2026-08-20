import { describe, expect, it } from "vitest";
import { ApprovalAuthority } from "../../src/approval/index.js";
import {
  meridianOpenShareArtifact,
  meridianRecordAndBalancesArtifact,
  meridianUpdateMemberArtifact,
} from "../../src/capabilities/index.js";
import type {
  CapabilityArtifactV2,
  ConditionV2,
  TargetV2,
} from "../../src/domain/index.js";
import { ReplayRunnerV2 } from "../../src/replay/replayRunnerV2.js";
import type {
  ReplayRuntimeV2,
  RuntimeActionResultV2,
  RuntimeConditionResultV2,
  RuntimeContextV2,
  RuntimePageStateV2,
  RuntimeValue,
} from "../../src/surface/replayRuntimeV2.js";

function sameValue(left: RuntimeValue, right: RuntimeValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class MeridianContractRuntime implements ReplayRuntimeV2 {
  readonly sessionId = "meridian-contract-session";
  readonly sessionRef = "meridian-contract-session-reference";
  readonly #artifact: CapabilityArtifactV2;
  readonly #targets: Map<string, TargetV2>;
  readonly #inputs: Readonly<Record<string, RuntimeValue>>;
  readonly #values = new Map<string, RuntimeValue>();
  readonly #origin: string;
  readonly #shares: RuntimeValue[];
  state: RuntimePageStateV2;
  actionCount = 0;
  commitCount = 0;

  constructor(
    artifact: CapabilityArtifactV2,
    inputs: Readonly<Record<string, RuntimeValue>>,
    shares: RuntimeValue[] = [],
  ) {
    this.#artifact = artifact;
    this.#targets = new Map(artifact.targets.map((target) => [target.id, target]));
    this.#inputs = inputs;
    this.#origin = new URL(artifact.compatibility.entryPoint).origin;
    this.#shares = shares;
    this.state = { url: `${this.#origin}/signon`, title: "MERIDIAN", httpStatus: 200, method: "GET" };
  }

  getTarget(id: string): TargetV2 {
    const target = this.#targets.get(id);
    if (!target) throw new Error(`Unknown target ${id}`);
    return target;
  }

  resolveValue(expression: Parameters<ReplayRuntimeV2["resolveValue"]>[0], context: RuntimeContextV2) {
    if (expression.kind === "literal") return expression.value;
    const source = expression.kind === "input" ? context.inputs : context.bindings;
    if (!Object.hasOwn(source, expression.name)) throw new Error(`Missing ${expression.kind} ${expression.name}`);
    return source[expression.name]!;
  }

  async act(
    action: Parameters<ReplayRuntimeV2["act"]>[0],
    context: RuntimeContextV2,
  ): Promise<RuntimeActionResultV2> {
    this.actionCount += 1;
    const startedAt = new Date().toISOString();
    if (action.kind === "fill" || action.kind === "select") {
      this.#values.set(action.targetId, this.resolveValue(action.value, context));
    } else if (action.kind === "click") {
      this.#click(action.targetId);
    } else if (action.kind === "extract") {
      const value = this.#targetValue(action.targetId);
      if (action.bindingName) context.bindings[action.bindingName] = value;
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        targetId: action.targetId,
        ...(action.bindingName ? { bindingName: action.bindingName } : {}),
        value,
        attempts: [],
      };
    } else if (action.kind === "extract_table") {
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        targetId: action.targetId,
        outputName: action.outputName,
        value: structuredClone(this.#shares),
        attempts: [],
      };
    }
    return { startedAt, completedAt: new Date().toISOString(), attempts: [] };
  }

  async evaluate(condition: ConditionV2, context: RuntimeContextV2): Promise<RuntimeConditionResultV2> {
    if (condition.kind === "all" || condition.kind === "any") {
      const results = [];
      for (const child of condition.conditions) results.push(await this.evaluate(child, context));
      const matched = condition.kind === "all"
        ? results.every((result) => result.matched)
        : results.some((result) => result.matched);
      return { matched, summary: `${condition.kind} matched=${matched}` };
    }
    if (condition.kind === "not") {
      const result = await this.evaluate(condition.condition, context);
      return { matched: !result.matched, summary: `not matched=${!result.matched}` };
    }
    if (condition.kind === "route") {
      const matched = new RegExp(condition.pattern, "u").test(new URL(this.state.url).pathname);
      return { matched, summary: `route matched=${matched}` };
    }
    if (condition.kind === "target_present") return { matched: condition.present, summary: "target present" };
    if (condition.kind === "target_visible") return { matched: condition.visible, summary: "target visible" };
    if (condition.kind === "target_value") {
      const actual = this.#targetValue(condition.targetId);
      const expected = this.resolveValue(condition.value, context);
      const matched = condition.operator === "equals"
        ? sameValue(actual, expected)
        : condition.operator === "contains"
          ? String(actual).includes(String(expected))
          : new RegExp(String(expected), "u").test(String(actual));
      return { matched, summary: `target value matched=${matched}` };
    }
    if (condition.kind === "http_status") {
      return { matched: this.state.httpStatus === condition.status, summary: "HTTP status evaluated" };
    }
    if (condition.kind === "page_title") {
      const matched = condition.exact
        ? this.state.title === condition.title
        : this.state.title.includes(condition.title);
      return { matched, summary: `title matched=${matched}` };
    }
    return { matched: false, summary: "No business marker is visible" };
  }

  waitFor(condition: ConditionV2, context: RuntimeContextV2): Promise<RuntimeConditionResultV2> {
    return this.evaluate(condition, context);
  }

  async pageState(): Promise<RuntimePageStateV2> {
    return { ...this.state };
  }

  async captureMaskedScreenshot(): Promise<Buffer> {
    return Buffer.from("masked");
  }

  async sanitizedDomSnapshot(): Promise<string> {
    return "<html><body>[REDACTED]</body></html>";
  }

  async close(): Promise<void> {}

  #click(targetId: string): void {
    const member = String(this.#inputs.member_number ?? "100234");
    let pathname: string | undefined;
    if (targetId === "main_menu") pathname = "/menu";
    else if (targetId === "member_inquiry") pathname = "/members";
    else if (targetId === "search") {
      const by = String(this.#values.get("search_by") ?? "number");
      const query = encodeURIComponent(String(this.#values.get("search_value") ?? member));
      this.state = { ...this.state, url: `${this.#origin}/members?by=${by}&q=${query}`, method: "GET" };
      return;
    } else if (targetId === "select_member") pathname = `/members/${member}`;
    else if (targetId === "open_transaction") {
      pathname = `/members/${member}/${this.#artifact.capability.id === "share.open" ? "open-share" : "transfer"}`;
    } else if (targetId === "open_update") pathname = `/members/${member}/update`;
    else if (targetId === "continue") pathname = `${new URL(this.state.url).pathname}/review`;
    else if (targetId === "commit") {
      pathname = new URL(this.state.url).pathname.replace(/\/review$/u, "/post");
      this.commitCount += 1;
    } else if (targetId === "save") {
      pathname = `/members/${member}`;
      this.commitCount += 1;
    }
    if (pathname) this.state = { ...this.state, url: `${this.#origin}${pathname}`, method: "GET" };
  }

  #targetValue(targetId: string): RuntimeValue {
    const stored = this.#values.get(targetId);
    if (stored !== undefined) return stored;
    const member = this.#inputs.member_number ?? "100234";
    const values: Record<string, RuntimeValue> = {
      member_number_value: member,
      member_name_value: "Ada Member",
      email_value: this.#inputs.email ?? "ada@example.test",
      phone_value: this.#inputs.phone ?? "+1 (206) 555-0142",
      address_value: this.#inputs.address ?? "10 Main Street",
      transaction_token: "deadbeef-abc",
      review_member: member,
      review_type: this.#inputs.share_type ?? "S0001",
      review_deposit: this.#inputs.initial_deposit ?? { currency: "USD", amount: "25.00", minorUnits: 2_500 },
      email: this.#inputs.email ?? "ada@example.test",
      phone: this.#inputs.phone ?? "+1 (206) 555-0142",
      address: this.#inputs.address ?? "10 Main Street",
    };
    return values[targetId] ?? "present";
  }
}

const authority = () => new ApprovalAuthority({ secret: Buffer.alloc(32, 42) });

describe("bundled MERIDIAN artifacts through ReplayRunnerV2", () => {
  it("rejects an invalid open-share request before any browser action", async () => {
    const inputs = {
      member_number: "100234",
      share_type: "UNKNOWN",
      initial_deposit: { currency: "USD", amount: "0.00", minorUnits: 0 },
    };
    const runtime = new MeridianContractRuntime(meridianOpenShareArtifact, inputs);
    const runner = new ReplayRunnerV2({ artifact: meridianOpenShareArtifact, inputs, runtime, approvalAuthority: authority() });

    const progress = await runner.run();
    expect(progress).toMatchObject({ status: "terminal", result: { status: "failure", code: "INPUT_INVALID" } });
    expect(runtime.actionCount).toBe(0);
  });

  it("binds and consumes a valid open-share approval before one commit", async () => {
    const inputs = {
      member_number: "100234",
      share_type: "S0070",
      initial_deposit: { currency: "USD", amount: "25.00", minorUnits: 2_500 },
    };
    const runtime = new MeridianContractRuntime(meridianOpenShareArtifact, inputs);
    const runner = new ReplayRunnerV2({ artifact: meridianOpenShareArtifact, inputs, runtime, approvalAuthority: authority() });

    const paused = await runner.run();
    if (paused.status !== "awaiting_approval") throw new Error("Expected open-share approval");
    expect(paused.challenge.summary).toEqual([
      expect.objectContaining({ targetId: "review_member", value: "100234" }),
      expect.objectContaining({ targetId: "review_type", value: "S0070" }),
      expect.objectContaining({ targetId: "review_deposit", value: inputs.initial_deposit }),
    ]);
    expect(runtime.commitCount).toBe(0);

    const completed = await runner.resume(runner.issueApproval({ id: "operator-1", roles: ["teller"] }));
    expect(completed).toMatchObject({ status: "terminal", result: { status: "success" } });
    expect(runtime.commitCount).toBe(1);
  });

  it.each([
    ["email", "not-an-email", "email must be an email"],
    ["phone", "letters-only", "phone does not match its pattern"],
  ] as const)("rejects malformed update-member %s before browser work", async (field, value, message) => {
    const inputs = {
      member_number: "100234",
      email: "ada@example.test",
      phone: "+1 (206) 555-0142",
      address: "10 Main Street",
      [field]: value,
    };
    const runtime = new MeridianContractRuntime(meridianUpdateMemberArtifact, inputs);
    const runner = new ReplayRunnerV2({ artifact: meridianUpdateMemberArtifact, inputs, runtime, approvalAuthority: authority() });

    const progress = await runner.run();
    expect(progress).toMatchObject({ status: "terminal", result: { status: "failure", code: "INPUT_INVALID" } });
    if (progress.status === "terminal" && progress.result.status === "failure") {
      expect(progress.result.message).toContain(message);
    }
    expect(runtime.actionCount).toBe(0);
  });

  it("binds a valid member update approval and verifies all saved outputs", async () => {
    const inputs = {
      member_number: "100234",
      email: "ada.updated@example.test",
      phone: "+1 (425) 555-0199",
      address: "200 Updated Avenue",
    };
    const runtime = new MeridianContractRuntime(meridianUpdateMemberArtifact, inputs);
    const runner = new ReplayRunnerV2({ artifact: meridianUpdateMemberArtifact, inputs, runtime, approvalAuthority: authority() });

    const paused = await runner.run();
    if (paused.status !== "awaiting_approval") throw new Error("Expected update approval");
    expect(paused.challenge.summary.map(({ targetId, value }) => ({ targetId, value }))).toEqual([
      { targetId: "email", value: inputs.email },
      { targetId: "phone", value: inputs.phone },
      { targetId: "address", value: inputs.address },
    ]);
    expect(runtime.commitCount).toBe(0);

    const completed = await runner.resume(runner.issueApproval({ id: "operator-1", roles: ["teller"] }));
    expect(completed).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        outputs: { email: inputs.email, phone: inputs.phone, address: inputs.address },
      },
    });
    expect(runtime.commitCount).toBe(1);
  });

  it.each([0, 1, 37, 100])("returns all %i balance rows as typed money", async (count) => {
    const inputs = { member_number: "100234" };
    const shares = Array.from({ length: count }, (_, index) => ({
      share_id: `100234-S${String(index + 1).padStart(4, "0")}`,
      type: index % 2 === 0 ? "Checking" : "Savings",
      balance: {
        currency: "USD",
        amount: `${index + 1}.25`,
        minorUnits: (index + 1) * 100 + 25,
      },
      status: index % 3 === 0 ? "HOLD" : "OPEN",
    }));
    const runtime = new MeridianContractRuntime(meridianRecordAndBalancesArtifact, inputs, shares);
    const runner = new ReplayRunnerV2({
      artifact: meridianRecordAndBalancesArtifact,
      inputs,
      runtime,
      approvalAuthority: authority(),
    });

    const completed = await runner.run();
    if (completed.status !== "terminal" || completed.result.status !== "success") {
      throw new Error("Expected balance success");
    }
    expect(completed.result.outputs.shares).toHaveLength(count);
    for (const row of completed.result.outputs.shares as Array<Record<string, RuntimeValue>>) {
      expect(row.balance).toMatchObject({ currency: "USD", minorUnits: expect.any(Number) });
    }
  });
});
