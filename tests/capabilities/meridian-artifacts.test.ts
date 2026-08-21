import { describe, expect, it } from "vitest";
import {
  meridianArtifacts,
  meridianOpenShareArtifact,
  meridianRecordAndBalancesArtifact,
  meridianTransferArtifact,
  meridianUpdateMemberArtifact,
} from "../../src/capabilities/index.js";
import { CapabilityCatalog } from "../../src/catalog/index.js";
import { CapabilityArtifactV2Schema } from "../../src/domain/index.js";
import { validateInvocationInputsV2 } from "../../src/replay/replayRunnerV2.js";

describe("bundled MERIDIAN capabilities", () => {
  it("ships one approved V2 artifact for every required function", () => {
    expect(meridianArtifacts).toHaveLength(8);
    expect(meridianArtifacts.map((artifact) => artifact.capability.id).sort()).toEqual([
      "account.place_hold",
      "funds.transfer",
      "member.get_record_and_balances",
      "member.search_by_last_name",
      "member.search_by_number",
      "member.update_information",
      "session.sign_on",
      "share.open",
    ]);
    for (const artifact of meridianArtifacts) {
      expect(CapabilityArtifactV2Schema.safeParse(artifact).success).toBe(true);
      expect(artifact.capability.approval).toBe("approved");
      expect(artifact.compatibility.vendorProduct).toBe("Meridian Core");
    }
  });

  it("requires a human approval on every business write and supervisor approval for holds", () => {
    const writes = meridianArtifacts.filter((artifact) => artifact.capability.risk !== "read");
    for (const artifact of writes) {
      expect(artifact.steps.some((step) => step.approval !== undefined)).toBe(true);
    }
    const hold = meridianArtifacts.find((artifact) => artifact.capability.id === "account.place_hold")!;
    expect(hold.capability.risk).toBe("supervisor_only");
    expect(hold.steps.find((step) => step.id === "commit_hold")?.approval?.kind).toBe("supervisor_confirmation");
  });

  it("derives supervisor handoff support only from the exact permission and approval gates", () => {
    const hold = meridianArtifacts.find((artifact) => artifact.capability.id === "account.place_hold")!;
    expect(CapabilityCatalog.fromArtifacts([hold]).list()[0]?.supportsSupervisorHandoff).toBe(true);

    const withoutPermissionTrigger = structuredClone(hold);
    const permission = withoutPermissionTrigger.runtimeStates.find(
      (state) => state.handoff?.action === "authenticate_supervisor",
    );
    if (!permission?.handoff) throw new Error("Expected supervisor permission handoff");
    delete permission.handoff.trigger;
    expect(
      CapabilityCatalog.fromArtifacts([withoutPermissionTrigger]).list()[0]?.supportsSupervisorHandoff,
    ).toBe(false);

    const withoutPermissionStatus = structuredClone(hold);
    const nonPermission = withoutPermissionStatus.runtimeStates.find(
      (state) => state.handoff?.action === "authenticate_supervisor",
    );
    if (!nonPermission || nonPermission.condition.kind !== "http_status") {
      throw new Error("Expected supervisor HTTP permission rule");
    }
    nonPermission.condition.status = 401;
    expect(
      CapabilityCatalog.fromArtifacts([withoutPermissionStatus]).list()[0]?.supportsSupervisorHandoff,
    ).toBe(false);
  });

  it("loads as an immutable approved catalog with stable digests", () => {
    const catalog = CapabilityCatalog.fromArtifacts(meridianArtifacts);
    expect(catalog.list()).toHaveLength(8);
    expect(catalog.get("funds.transfer", "2.0.0")?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(catalog.resolve("funds.transfer", "2.0.0")?.artifact)).toBe(true);
  });

  it("uses row-scoped member selection and never positional Select links", () => {
    for (const artifact of meridianArtifacts.filter((item) => item.inputs.some((input) => input.name === "member_number"))) {
      const selector = artifact.targets.find((target) => target.id === "select_member");
      expect(selector?.strategies[0]?.kind).toBe("table_row_control");
      expect(artifact.targets.some((target) => target.id === "member_number_value")).toBe(true);
      const selectStep = artifact.steps.find((step) => step.id === "select_member");
      expect(selectStep?.postcondition.kind).toBe("all");
      if (selectStep?.postcondition.kind !== "all") throw new Error("Expected a compound member binding checkpoint");
      expect(selectStep.postcondition.conditions).toContainEqual(expect.objectContaining({
        kind: "target_value",
        targetId: "member_number_value",
        operator: "equals",
        value: { kind: "input", name: "member_number" },
      }));
    }
  });

  it("binds transfer and hold shares to the requested member before browser work", () => {
    expect(meridianTransferArtifact.policy.inputRelations).toEqual([
      { kind: "starts_with_input", value: "from_share", prefix: "member_number", separator: "-" },
      { kind: "starts_with_input", value: "to_share", prefix: "member_number", separator: "-" },
      { kind: "not_equal", left: "from_share", right: "to_share" },
    ]);
    const hold = meridianArtifacts.find((artifact) => artifact.capability.id === "account.place_hold")!;
    expect(hold.policy.inputRelations).toContainEqual({
      kind: "starts_with_input",
      value: "share",
      prefix: "member_number",
      separator: "-",
    });
  });

  it("validates open-share and member-update contracts before replay", () => {
    const validDeposit = { currency: "USD", amount: "25.00", minorUnits: 2_500 } as const;
    expect(validateInvocationInputsV2(meridianOpenShareArtifact.inputs, {
      member_number: "100234",
      share_type: "S0001",
      initial_deposit: validDeposit,
    })).toEqual([]);
    expect(validateInvocationInputsV2(meridianOpenShareArtifact.inputs, {
      member_number: "100234",
      share_type: "UNKNOWN",
      initial_deposit: { currency: "USD", amount: "0.00", minorUnits: 0 },
    })).toEqual(expect.arrayContaining([
      "share_type is not an allowed value",
      "initial_deposit is below its minimum",
    ]));

    expect(validateInvocationInputsV2(meridianUpdateMemberArtifact.inputs, {
      member_number: "100234",
      email: "member@example.test",
      phone: "+1 (206) 555-0142",
      address: "10 Main Street",
    })).toEqual([]);
    expect(validateInvocationInputsV2(meridianUpdateMemberArtifact.inputs, {
      member_number: "123",
      email: "invalid",
      phone: "abc",
      address: "x",
    })).toEqual(expect.arrayContaining([
      "member_number is shorter than allowed",
      "email must be an email",
      "phone does not match its pattern",
      "address is shorter than allowed",
    ]));
  });

  it("requires opaque approval nonces and exact positive write receipts", () => {
    for (const artifact of meridianArtifacts) {
      for (const step of artifact.steps.filter((candidate) => candidate.approval)) {
        expect(step.approval?.stateNonceTarget).toBe("transaction_token");
        expect(artifact.targets.find((target) => target.id === step.approval?.stateNonceTarget)?.sensitive).toBe(true);
        const tokenContract = step.preconditions.find((condition) =>
          condition.kind === "all" && condition.conditions.some(
            (child) => child.kind === "target_present" && child.targetId === "transaction_token",
          ));
        expect(tokenContract).toMatchObject({
          kind: "all",
          conditions: expect.arrayContaining([
            { kind: "target_present", targetId: "transaction_token", present: true },
          ]),
        });
        const tokenGuard = tokenContract?.kind === "all"
          ? tokenContract.conditions.find(
            (condition) => condition.kind === "target_value" && condition.targetId === "transaction_token",
          )
          : undefined;
        expect(tokenGuard).toMatchObject({ operator: "matches", redactActual: true });
        if (tokenGuard?.kind !== "target_value" || tokenGuard.value.kind !== "literal") {
          throw new Error("Expected an authored opaque-token guard");
        }
        const pattern = new RegExp(String(tokenGuard.value.value), "u");
        expect(pattern.test("opaque/K9x:Yz!2026")).toBe(true);
        expect(pattern.test("")).toBe(false);
        expect(pattern.test("opaque-token\n")).toBe(false);
        expect(pattern.test("x".repeat(257))).toBe(false);
        expect(artifact.outputs.some((output) => output.name.includes("token"))).toBe(false);
      }
    }

    const writes = [
      {
        artifact: meridianTransferArtifact,
        title: "Transfer Posted - Meridian Core",
        outputs: ["source_balance_before", "destination_balance_before", "confirmation", "posted_at", "amount", "source_balance", "destination_balance"],
        receiptTargets: ["receipt_confirmation", "receipt_posted", "receipt_amount", "receipt_source_balance", "receipt_destination_balance"],
      },
      {
        artifact: meridianOpenShareArtifact,
        title: "Share Opened - Meridian Core",
        outputs: ["shares_before", "confirmation", "new_share_id", "share_type", "opening_balance"],
        receiptTargets: ["receipt_confirmation", "receipt_new_share_id", "receipt_share_type", "receipt_opening_balance"],
      },
      {
        artifact: meridianArtifacts.find((artifact) => artifact.capability.id === "account.place_hold")!,
        title: "Hold Applied - Meridian Core",
        outputs: ["share_status_before", "confirmation", "share_status", "applied_at"],
        receiptTargets: ["receipt_confirmation", "receipt_share_status", "receipt_applied"],
      },
    ];
    for (const { artifact, title, outputs, receiptTargets } of writes) {
      expect(artifact.outputs.map((output) => output.name)).toEqual(outputs);
      expect(artifact.checkpoint).toMatchObject({
        kind: "all",
        conditions: expect.arrayContaining([
          { kind: "page_title", title, exact: true },
          ...receiptTargets.map((targetId) => ({ kind: "target_present", targetId, present: true })),
        ]),
      });
      for (const output of outputs) {
        expect(artifact.steps.filter(
          (step) => (step.action.kind === "extract" || step.action.kind === "extract_table") && step.action.outputName === output,
        )).toHaveLength(1);
      }
    }

    expect(meridianTransferArtifact.targets.find((item) => item.id === "receipt_source_balance")?.strategies[0]).toEqual({
      kind: "label_value_expr",
      label: { kind: "input", name: "from_share" },
      prefix: "",
      suffix: ":",
      valueCellOffset: 1,
    });
    expect(meridianTransferArtifact.targets.find((item) => item.id === "receipt_destination_balance")?.strategies[0]).toEqual({
      kind: "label_value_expr",
      label: { kind: "input", name: "to_share" },
      prefix: "",
      suffix: ":",
      valueCellOffset: 1,
    });

    const reconciliationMarkers = [
      { artifact: meridianTransferArtifact, commit: "commit_transfer", outputs: ["source_balance_before", "destination_balance_before"] },
      { artifact: meridianOpenShareArtifact, commit: "commit_new_share", outputs: ["shares_before"] },
      { artifact: meridianUpdateMemberArtifact, commit: "save_update", outputs: ["email_before", "phone_before", "address_before"] },
      { artifact: meridianArtifacts.find((artifact) => artifact.capability.id === "account.place_hold")!, commit: "commit_hold", outputs: ["share_status_before"] },
    ];
    for (const { artifact, commit, outputs } of reconciliationMarkers) {
      const commitIndex = artifact.steps.findIndex((step) => step.id === commit);
      expect(commitIndex).toBeGreaterThan(0);
      for (const outputName of outputs) {
        const markerIndex = artifact.steps.findIndex(
          (step) => (step.action.kind === "extract" || step.action.kind === "extract_table") && step.action.outputName === outputName,
        );
        expect(markerIndex).toBeGreaterThanOrEqual(0);
        expect(markerIndex).toBeLessThan(commitIndex);
      }
    }
  });

  it("rejects malformed type, table, approval, and restart semantics", () => {
    const invalidBounds = structuredClone(meridianOpenShareArtifact) as any;
    invalidBounds.inputs.find((input: any) => input.name === "initial_deposit").type = {
      kind: "money",
      currency: "USD",
      minimumMinorUnits: 100,
      maximumMinorUnits: 10,
    };
    expect(CapabilityArtifactV2Schema.safeParse(invalidBounds).success).toBe(false);

    const duplicateHeaders = structuredClone(meridianRecordAndBalancesArtifact) as any;
    const tableStrategy = duplicateHeaders.targets.find((target: any) => target.id === "shares_table").strategies[0];
    tableStrategy.headers = ["Share ID", "Share ID"];
    expect(CapabilityArtifactV2Schema.safeParse(duplicateHeaders).success).toBe(false);

    const mismatchedColumns = structuredClone(meridianRecordAndBalancesArtifact) as any;
    const tableAction = mismatchedColumns.steps.find((step: any) => step.action.kind === "extract_table").action;
    tableAction.columns[0].key = "balance";
    expect(CapabilityArtifactV2Schema.safeParse(mismatchedColumns).success).toBe(false);

    const duplicateSummary = structuredClone(meridianTransferArtifact) as any;
    const commit = duplicateSummary.steps.find((step: any) => step.id === "commit_transfer");
    commit.approval.summaryTargets.push(commit.approval.summaryTargets[0]);
    expect(CapabilityArtifactV2Schema.safeParse(duplicateSummary).success).toBe(false);

    const restartBeforeWrite = structuredClone(meridianUpdateMemberArtifact) as any;
    const save = restartBeforeWrite.steps.find((step: any) => step.id === "save_update");
    save.safeRestartStepId = "enter_email";
    expect(CapabilityArtifactV2Schema.safeParse(restartBeforeWrite).success).toBe(false);

    const understatedRisk = structuredClone(meridianTransferArtifact) as any;
    understatedRisk.capability.risk = "read";
    expect(CapabilityArtifactV2Schema.safeParse(understatedRisk).success).toBe(false);

    const invalidConditionPattern = structuredClone(meridianTransferArtifact) as any;
    invalidConditionPattern.checkpoint = { kind: "route", pattern: "(" };
    expect(CapabilityArtifactV2Schema.safeParse(invalidConditionPattern).success).toBe(false);
  });

  it("classifies injected status states by member route and explicit effect certainty", () => {
    const statusState = (code: string) => meridianTransferArtifact.runtimeStates.find((state) => state.code === code)!;
    expect(statusState("RECORD_NOT_FOUND")).toMatchObject({
      category: "business_outcome",
      effectCertainty: "not_applied",
      condition: { kind: "all" },
    });
    expect(statusState("VALIDATION_REJECTED")).toMatchObject({
      category: "business_outcome",
      effectCertainty: "not_applied",
      condition: { kind: "all" },
    });
    expect(statusState("SUPERVISOR_REQUIRED")).toMatchObject({
      category: "intervention",
      effectCertainty: "not_applied",
      requiredRole: "supervisor",
      handoff: {
        action: "authenticate_supervisor",
        trigger: { kind: "capability_role", role: "supervisor" },
      },
    });
    expect(statusState("SESSION_EXPIRED")).toMatchObject({
      category: "intervention",
      effectCertainty: "not_applied",
      handoff: {
        kind: "same_session",
        action: "restore_session",
        resume: { kind: "restart_run" },
        revalidate: [{ kind: "route", pattern: "^/menu$" }],
      },
    });
    expect(statusState("MAINTENANCE").effectCertainty).toBeUndefined();
    expect(statusState("APPLICATION_ERROR").effectCertainty).toBeUndefined();
  });

  it("requires fail-closed same-session directives for intervention states", () => {
    const missingHandoff = structuredClone(meridianTransferArtifact) as any;
    const missingState = missingHandoff.runtimeStates.find((state: any) => state.code === "SESSION_EXPIRED");
    delete missingState.handoff;
    expect(CapabilityArtifactV2Schema.safeParse(missingHandoff).success).toBe(false);

    const uncertain = structuredClone(meridianTransferArtifact) as any;
    const uncertainState = uncertain.runtimeStates.find((state: any) => state.code === "SESSION_EXPIRED");
    uncertainState.effectCertainty = "unknown";
    expect(CapabilityArtifactV2Schema.safeParse(uncertain).success).toBe(false);

    const undeclaredTarget = structuredClone(meridianTransferArtifact) as any;
    const invalidState = undeclaredTarget.runtimeStates.find((state: any) => state.code === "SESSION_EXPIRED");
    invalidState.handoff.revalidate = [{ kind: "target_present", targetId: "unreviewed_control", present: true }];
    expect(CapabilityArtifactV2Schema.safeParse(undeclaredTarget).success).toBe(false);
  });
});
