import { describe, expect, it } from "vitest";
import { ApprovalAuthority } from "../../src/approval/index.js";
import {
  meridianOpenShareArtifact,
  meridianPlaceHoldArtifact,
  meridianRecordAndBalancesArtifact,
  meridianTransferArtifact,
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

function scalarText(value: RuntimeValue): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.amount === "string") {
    return value.amount;
  }
  return String(value);
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
    shares?: RuntimeValue[],
  ) {
    this.#artifact = artifact;
    this.#targets = new Map(artifact.targets.map((target) => [target.id, target]));
    this.#inputs = inputs;
    this.#origin = new URL(artifact.compatibility.entryPoint).origin;
    this.#shares = shares ?? [
      { share_id: "100234-S0001", type: "Checking", balance: { currency: "USD", amount: "250.00", minorUnits: 25_000 }, status: "OPEN" },
      { share_id: "100234-S0070", type: "Savings", balance: { currency: "USD", amount: "150.00", minorUnits: 15_000 }, status: "OPEN" },
    ];
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
      let value = this.#targetValue(action.targetId);
      if (action.transform?.kind === "strip_exact_suffix") {
        if (typeof value !== "string" || !value.endsWith(action.transform.suffix)) {
          throw new Error("Missing exact extraction suffix");
        }
        value = value.slice(0, -action.transform.suffix.length).trim();
      }
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
          ? String(actual).includes(scalarText(expected))
          : new RegExp(scalarText(expected), "u").test(String(actual));
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
      const transaction = this.#artifact.capability.id === "share.open"
        ? "open-share"
        : this.#artifact.capability.id === "account.place_hold"
          ? "hold"
          : "transfer";
      pathname = `/members/${member}/${transaction}`;
    } else if (targetId === "open_update") pathname = `/members/${member}/update`;
    else if (targetId === "continue") pathname = `${new URL(this.state.url).pathname}/review`;
    else if (targetId === "commit") {
      pathname = new URL(this.state.url).pathname.replace(/\/review$/u, "/post");
      this.commitCount += 1;
      const title = this.#artifact.capability.id === "share.open"
        ? "Share Opened - Meridian Core"
        : this.#artifact.capability.id === "account.place_hold"
          ? "Hold Applied - Meridian Core"
          : "Transfer Posted - Meridian Core";
      this.state = { ...this.state, title };
    } else if (targetId === "save") {
      pathname = `/members/${member}/update`;
      this.commitCount += 1;
    } else if (targetId === "return_member_record") {
      pathname = `/members/${member}`;
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
      email_value: this.commitCount > 0 ? this.#inputs.email ?? "ada@example.test" : "ada@example.test",
      phone_value: this.commitCount > 0 ? this.#inputs.phone ?? "+1 (206) 555-0142" : "+1 (206) 555-0142",
      address_value: this.commitCount > 0 ? this.#inputs.address ?? "10 Main Street" : "10 Main Street",
      transaction_token: "opaque/K9x:Yz!2026",
      review_member: member,
      review_type: this.#inputs.share_type ?? "S0001",
      review_deposit: this.#inputs.initial_deposit ?? { currency: "USD", amount: "25.00", minorUnits: 2_500 },
      review_from: this.#inputs.from_share ?? "100234-S0001",
      review_to: this.#inputs.to_share ?? "100234-S0070",
      review_amount: this.#inputs.amount ?? { currency: "USD", amount: "5.00", minorUnits: 500 },
      review_memo: this.#inputs.memo ?? "Contract verification",
      review_share: this.#inputs.share ?? "100234-S0001",
      review_reason: this.#inputs.reason ?? "FRAUD",
      review_notes: this.#inputs.notes ?? "Contract verification",
      receipt_confirmation: this.#artifact.capability.id === "share.open"
        ? "NS-ABC123"
        : this.#artifact.capability.id === "account.place_hold"
          ? "HD-ABC123"
          : "TR-ABC123",
      receipt_posted: "2026-08-20T18:00:00.000Z",
      receipt_amount: `$${String((this.#inputs.amount as { amount?: string } | undefined)?.amount ?? "5.00")}`,
      source_balance_before: "$250.00",
      destination_balance_before: "$150.00",
      share_status_before: "OPEN",
      receipt_source_balance: "$245.00 (new balance)",
      receipt_destination_balance: "$155.00 (new balance)",
      receipt_new_share_id: `${String(member)}-${String(this.#inputs.share_type ?? "S0001")}-0003`,
      receipt_share_type: this.#inputs.share_type ?? "S0001",
      receipt_opening_balance: `$${String((this.#inputs.initial_deposit as { amount?: string } | undefined)?.amount ?? "25.00")}`,
      receipt_share_status: `${String(this.#inputs.share ?? "100234-S0001")} is now HOLD`,
      receipt_applied: "2026-08-20T18:00:00.000Z",
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
    expect(completed).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        outputs: {
          shares_before: [
            {
              share_id: "100234-S0001",
              type: "Checking",
              balance: { currency: "USD", amount: "250.00", minorUnits: 25_000 },
              status: "OPEN",
            },
            {
              share_id: "100234-S0070",
              type: "Savings",
              balance: { currency: "USD", amount: "150.00", minorUnits: 15_000 },
              status: "OPEN",
            },
          ],
          confirmation: "NS-ABC123",
          new_share_id: "100234-S0070-0003",
          share_type: "S0070",
          opening_balance: { currency: "USD", amount: "25.00", minorUnits: 2_500 },
        },
      },
    });
    expect(runtime.commitCount).toBe(1);
  });

  it("returns a typed transfer receipt with both resulting balances", async () => {
    const inputs = {
      member_number: "100234",
      from_share: "100234-S0001",
      to_share: "100234-S0070",
      amount: { currency: "USD", amount: "5.00", minorUnits: 500 },
      memo: "Contract verification",
    };
    const runtime = new MeridianContractRuntime(meridianTransferArtifact, inputs);
    const runner = new ReplayRunnerV2({ artifact: meridianTransferArtifact, inputs, runtime, approvalAuthority: authority() });

    const paused = await runner.run();
    if (paused.status !== "awaiting_approval") throw new Error("Expected transfer approval");
    const completed = await runner.resume(runner.issueApproval({ id: "operator-1", roles: ["teller"] }));

    expect(completed).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        outputs: {
          source_balance_before: { currency: "USD", amount: "250.00", minorUnits: 25_000 },
          destination_balance_before: { currency: "USD", amount: "150.00", minorUnits: 15_000 },
          confirmation: "TR-ABC123",
          posted_at: "2026-08-20T18:00:00.000Z",
          amount: { currency: "USD", amount: "5.00", minorUnits: 500 },
          source_balance: { currency: "USD", amount: "245.00", minorUnits: 24_500 },
          destination_balance: { currency: "USD", amount: "155.00", minorUnits: 15_500 },
        },
      },
    });
    expect(runtime.commitCount).toBe(1);
  });

  it("returns an exact supervisor hold receipt", async () => {
    const inputs = {
      member_number: "100234",
      share: "100234-S0001",
      reason: "FRAUD",
      notes: "Contract verification",
    };
    const runtime = new MeridianContractRuntime(meridianPlaceHoldArtifact, inputs);
    const runner = new ReplayRunnerV2({ artifact: meridianPlaceHoldArtifact, inputs, runtime, approvalAuthority: authority() });

    const paused = await runner.run();
    if (paused.status !== "awaiting_approval") throw new Error("Expected supervisor approval");
    const completed = await runner.resume(runner.issueApproval({ id: "supervisor-1", roles: ["supervisor"] }));

    expect(completed).toMatchObject({
      status: "terminal",
      result: {
        status: "success",
        outputs: {
          share_status_before: "OPEN",
          confirmation: "HD-ABC123",
          share_status: "100234-S0001 is now HOLD",
          applied_at: "2026-08-20T18:00:00.000Z",
        },
      },
    });
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
        outputs: {
          email_before: "ada@example.test",
          phone_before: "+1 (206) 555-0142",
          address_before: "10 Main Street",
          email: inputs.email,
          phone: inputs.phone,
          address: inputs.address,
        },
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
