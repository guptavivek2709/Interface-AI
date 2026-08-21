import type { RunValueV2 } from "../domain/index.js";
import {
  reconcileAccountHold,
  reconcileMemberUpdate,
  reconcileShareOpen,
  reconcileTransfer,
  type ReconciliationDecision,
  type ShareMarker,
} from "./classifier.js";

export const RECONCILABLE_CAPABILITIES = Object.freeze([
  "funds.transfer",
  "share.open",
  "member.update_information",
  "account.place_hold",
] as const);

export type ReconcilableCapabilityId = typeof RECONCILABLE_CAPABILITIES[number];

export function isReconcilableCapability(value: string): value is ReconcilableCapabilityId {
  return (RECONCILABLE_CAPABILITIES as readonly string[]).includes(value);
}

function record(value: RunValueV2 | undefined): Readonly<Record<string, RunValueV2>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, RunValueV2>>
    : undefined;
}

function text(value: RunValueV2 | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function minor(value: RunValueV2 | undefined): number | undefined {
  const object = record(value);
  const amount = object?.["minorUnits"];
  return typeof amount === "number" && Number.isSafeInteger(amount) ? amount : undefined;
}

function share(value: RunValueV2): ShareMarker | undefined {
  const object = record(value);
  const shareId = text(object?.["share_id"]);
  const type = text(object?.["type"]);
  const balanceMinor = minor(object?.["balance"]);
  const status = text(object?.["status"]);
  return shareId && type && balanceMinor !== undefined && status
    ? { shareId, type, balanceMinor, status }
    : undefined;
}

function shares(value: RunValueV2 | undefined): readonly ShareMarker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(share);
  return parsed.every((item): item is ShareMarker => item !== undefined) ? parsed : undefined;
}

function unknown(reason: string, checkedFields: readonly string[]): ReconciliationDecision {
  return Object.freeze({
    classification: "still_unknown",
    reason,
    checkedFields: Object.freeze([...checkedFields]),
  });
}

export function reconciliationReadInputs(
  sourceInputs: Readonly<Record<string, RunValueV2>>,
): Readonly<Record<string, RunValueV2>> {
  const memberNumber = text(sourceInputs["member_number"]);
  if (!memberNumber) throw new TypeError("Reconciliation requires the exact source member_number");
  return Object.freeze({ member_number: memberNumber });
}

/** Classifies one completed read-only member snapshot against bound pre-commit markers. */
export function classifyReconciliation(input: {
  readonly capabilityId: ReconcilableCapabilityId;
  readonly sourceInputs: Readonly<Record<string, RunValueV2>>;
  readonly preCommit: Readonly<Record<string, RunValueV2>>;
  readonly current: Readonly<Record<string, RunValueV2>>;
}): ReconciliationDecision {
  const currentShares = shares(input.current["shares"]);
  if (input.capabilityId === "funds.transfer") {
    const fromShare = text(input.sourceInputs["from_share"]);
    const toShare = text(input.sourceInputs["to_share"]);
    const amountMinor = minor(input.sourceInputs["amount"]);
    const beforeFrom = minor(input.preCommit["source_balance_before"]);
    const beforeTo = minor(input.preCommit["destination_balance_before"]);
    if (!fromShare || !toShare || amountMinor === undefined || beforeFrom === undefined || beforeTo === undefined) {
      return unknown("The transfer's exact pre-commit balance markers were unavailable.", [
        "from_share", "to_share", "amount", "before_balances", "current_balances",
      ]);
    }
    const currentFrom = currentShares?.find((item) => item.shareId === fromShare);
    const currentTo = currentShares?.find((item) => item.shareId === toShare);
    return reconcileTransfer({
      amountMinor,
      beforeFrom: { shareId: fromShare, balanceMinor: beforeFrom },
      beforeTo: { shareId: toShare, balanceMinor: beforeTo },
      ...(currentFrom ? { currentFrom: { shareId: currentFrom.shareId, balanceMinor: currentFrom.balanceMinor } } : {}),
      ...(currentTo ? { currentTo: { shareId: currentTo.shareId, balanceMinor: currentTo.balanceMinor } } : {}),
    });
  }

  if (input.capabilityId === "share.open") {
    const requestedType = text(input.sourceInputs["share_type"]);
    // MERIDIAN receipts/member rows expose the display label for Regular
    // Shares while the reviewed form uses its stable S0001 code.
    const expectedType = requestedType === "S0001" ? "Regular Shares" : requestedType;
    const expectedOpeningBalanceMinor = minor(input.sourceInputs["initial_deposit"]);
    const beforeShares = shares(input.preCommit["shares_before"]);
    if (!expectedType || expectedOpeningBalanceMinor === undefined || !beforeShares || !currentShares) {
      return unknown("The share-open before/current share snapshots were incomplete.", [
        "before_share_ids", "current_share_ids", "share_type", "opening_balance",
      ]);
    }
    return reconcileShareOpen({ expectedType, expectedOpeningBalanceMinor, beforeShares, currentShares });
  }

  if (input.capabilityId === "member.update_information") {
    const before = {
      email: text(input.preCommit["email_before"]),
      phone: text(input.preCommit["phone_before"]),
      address: text(input.preCommit["address_before"]),
    };
    const requested = {
      email: text(input.sourceInputs["email"]),
      phone: text(input.sourceInputs["phone"]),
      address: text(input.sourceInputs["address"]),
    };
    const current = {
      email: text(input.current["email"]),
      phone: text(input.current["phone"]),
      address: text(input.current["address"]),
    };
    if (
      !before.email || !before.phone || !before.address ||
      !requested.email || !requested.phone || !requested.address
    ) {
      return unknown("The member update's exact pre-commit or requested contact values were unavailable.", [
        "email", "phone", "address", "pre_commit_values",
      ]);
    }
    return reconcileMemberUpdate({
      before: { email: before.email, phone: before.phone, address: before.address },
      requested: { email: requested.email, phone: requested.phone, address: requested.address },
      ...(current.email && current.phone && current.address
        ? { current: { email: current.email, phone: current.phone, address: current.address } }
        : {}),
    });
  }

  const shareId = text(input.sourceInputs["share"]);
  const beforeStatus = text(input.preCommit["share_status_before"]);
  const currentShare = currentShares?.find((item) => item.shareId === shareId);
  if (!shareId || !beforeStatus) {
    return unknown("The account hold's exact pre-commit share status was unavailable.", [
      "share_id", "before_status", "current_status",
    ]);
  }
  return reconcileAccountHold({
    shareId,
    beforeStatus,
    ...(currentShare ? { currentShare: { shareId: currentShare.shareId, status: currentShare.status } } : {}),
  });
}
