import { describe, expect, it } from "vitest";
import { classifyReconciliation, reconciliationReadInputs } from "../../src/reconciliation/workflow.js";

const money = (minorUnits: number) => ({
  currency: "USD",
  amount: (minorUnits / 100).toFixed(2),
  minorUnits,
});

const share = (share_id: string, balanceMinor: number, status = "OPEN", type = "Regular Shares") => ({
  share_id,
  type,
  balance: money(balanceMinor),
  status,
});

describe("operational reconciliation workflow", () => {
  it("derives only the exact member read input", () => {
    expect(reconciliationReadInputs({ member_number: "100234", memo: "private" })).toEqual({
      member_number: "100234",
    });
  });

  it("classifies exact transfer deltas from production marker names", () => {
    expect(classifyReconciliation({
      capabilityId: "funds.transfer",
      sourceInputs: {
        member_number: "100234",
        from_share: "100234-S0001",
        to_share: "100234-S0070",
        amount: money(100),
      },
      preCommit: {
        source_balance_before: money(1_000),
        destination_balance_before: money(500),
      },
      current: {
        shares: [share("100234-S0001", 900), share("100234-S0070", 600)],
      },
    }).classification).toBe("applied");
  });

  it("classifies a unique opened share against the complete prior share set", () => {
    expect(classifyReconciliation({
      capabilityId: "share.open",
      sourceInputs: {
        member_number: "100234",
        share_type: "S0001",
        initial_deposit: money(500),
      },
      preCommit: { shares_before: [share("100234-S0070", 1_000, "OPEN", "Savings")] },
      current: {
        shares: [
          share("100234-S0070", 1_000, "OPEN", "Savings"),
          share("100234-S0001-2", 500, "OPEN", "Regular Shares"),
        ],
      },
    }).classification).toBe("applied");
  });

  it("classifies complete member updates and exact hold status transitions", () => {
    expect(classifyReconciliation({
      capabilityId: "member.update_information",
      sourceInputs: {
        member_number: "100234",
        email: "new@example.test",
        phone: "555-0199",
        address: "200 New Street",
      },
      preCommit: {
        email_before: "old@example.test",
        phone_before: "555-0100",
        address_before: "100 Old Street",
      },
      current: {
        email: "new@example.test",
        phone: "555-0199",
        address: "200 New Street",
      },
    }).classification).toBe("applied");

    expect(classifyReconciliation({
      capabilityId: "account.place_hold",
      sourceInputs: { member_number: "100234", share: "100234-S0001" },
      preCommit: { share_status_before: "OPEN" },
      current: { shares: [share("100234-S0001", 1_000, "HOLD")] },
    }).classification).toBe("applied");
  });

  it("fails closed when any reviewed marker is absent", () => {
    expect(classifyReconciliation({
      capabilityId: "funds.transfer",
      sourceInputs: {},
      preCommit: {},
      current: {},
    }).classification).toBe("still_unknown");
  });
});
