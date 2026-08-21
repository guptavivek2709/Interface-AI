import { describe, expect, it } from "vitest";
import {
  reconcileAccountHold,
  reconcileMemberUpdate,
  reconcileShareOpen,
  reconcileTransfer,
} from "../../src/reconciliation/index.js";

describe("read-only reconciliation classifiers", () => {
  it.each([
    [9_900, 5_100, "applied"],
    [10_000, 5_000, "not_applied"],
    [9_950, 5_050, "still_unknown"],
  ] as const)("classifies transfer balance markers", (from, to, expected) => {
    expect(reconcileTransfer({
      amountMinor: 100,
      beforeFrom: { shareId: "100234-S0001", balanceMinor: 10_000 },
      beforeTo: { shareId: "100234-S0070", balanceMinor: 5_000 },
      currentFrom: { shareId: "100234-S0001", balanceMinor: from },
      currentTo: { shareId: "100234-S0070", balanceMinor: to },
    }).classification).toBe(expected);
  });

  it("requires exactly one matching new share", () => {
    const before = [{ shareId: "100234-S0001", type: "Checking", balanceMinor: 1_000, status: "OPEN" }];
    expect(reconcileShareOpen({
      expectedType: "S0070",
      expectedOpeningBalanceMinor: 2_500,
      beforeShares: before,
      currentShares: [...before, { shareId: "100234-S0070-2", type: "S0070", balanceMinor: 2_500, status: "OPEN" }],
    }).classification).toBe("applied");
    expect(reconcileShareOpen({
      expectedType: "S0070",
      expectedOpeningBalanceMinor: 2_500,
      beforeShares: before,
      currentShares: before,
    }).classification).toBe("not_applied");
  });

  it("compares all member contact fields atomically", () => {
    const before = { email: "before@example.test", phone: "111-111-1111", address: "Before Street" };
    const requested = { email: "after@example.test", phone: "222-222-2222", address: "After Street" };
    expect(reconcileMemberUpdate({ before, requested, current: requested }).classification).toBe("applied");
    expect(reconcileMemberUpdate({ before, requested, current: before }).classification).toBe("not_applied");
    expect(reconcileMemberUpdate({ before, requested, current: { ...requested, phone: before.phone } }).classification).toBe("still_unknown");
  });

  it("uses exact share identity and a bound before status for holds", () => {
    expect(reconcileAccountHold({
      shareId: "100234-S0001",
      beforeStatus: "OPEN",
      currentShare: { shareId: "100234-S0001", status: "HOLD" },
    }).classification).toBe("applied");
    expect(reconcileAccountHold({
      shareId: "100234-S0001",
      beforeStatus: "OPEN",
      currentShare: { shareId: "100234-S0001", status: "OPEN" },
    }).classification).toBe("not_applied");
  });
});
