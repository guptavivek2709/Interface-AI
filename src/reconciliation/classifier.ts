import { z } from "zod";

export const ReconciliationClassificationSchema = z.enum([
  "applied",
  "not_applied",
  "still_unknown",
]);
export type ReconciliationClassification = z.infer<typeof ReconciliationClassificationSchema>;

export interface ReconciliationDecision {
  readonly classification: ReconciliationClassification;
  readonly reason: string;
  readonly checkedFields: readonly string[];
}

export interface BalanceMarker {
  readonly shareId: string;
  readonly balanceMinor: number;
}

function validMinor(value: number): boolean {
  return Number.isSafeInteger(value);
}

function decision(
  classification: ReconciliationClassification,
  reason: string,
  checkedFields: readonly string[],
): ReconciliationDecision {
  return Object.freeze({ classification, reason, checkedFields: Object.freeze([...checkedFields]) });
}

export function reconcileTransfer(input: {
  readonly amountMinor: number;
  readonly beforeFrom: BalanceMarker;
  readonly beforeTo: BalanceMarker;
  readonly currentFrom?: BalanceMarker;
  readonly currentTo?: BalanceMarker;
}): ReconciliationDecision {
  const checked = ["from_share", "to_share", "amount", "before_balances", "current_balances"];
  if (
    !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
    !validMinor(input.beforeFrom.balanceMinor) || !validMinor(input.beforeTo.balanceMinor) ||
    input.beforeFrom.shareId === input.beforeTo.shareId ||
    input.currentFrom?.shareId !== input.beforeFrom.shareId ||
    input.currentTo?.shareId !== input.beforeTo.shareId ||
    !validMinor(input.currentFrom?.balanceMinor ?? Number.NaN) ||
    !validMinor(input.currentTo?.balanceMinor ?? Number.NaN)
  ) {
    return decision("still_unknown", "The exact source and destination balance markers were not both available.", checked);
  }
  const applied =
    input.currentFrom.balanceMinor === input.beforeFrom.balanceMinor - input.amountMinor &&
    input.currentTo.balanceMinor === input.beforeTo.balanceMinor + input.amountMinor;
  if (applied) {
    return decision("applied", "Both balances changed by the exact reviewed transfer amount.", checked);
  }
  const unchanged =
    input.currentFrom.balanceMinor === input.beforeFrom.balanceMinor &&
    input.currentTo.balanceMinor === input.beforeTo.balanceMinor;
  if (unchanged) {
    return decision("not_applied", "Both balances remain at their bound pre-commit values.", checked);
  }
  return decision("still_unknown", "The balances changed, but not by the exact reviewed transfer delta.", checked);
}

export interface ShareMarker {
  readonly shareId: string;
  readonly type: string;
  readonly balanceMinor: number;
  readonly status: string;
}

export function reconcileShareOpen(input: {
  readonly expectedType: string;
  readonly expectedOpeningBalanceMinor: number;
  readonly beforeShares: readonly ShareMarker[];
  readonly currentShares: readonly ShareMarker[];
}): ReconciliationDecision {
  const checked = ["before_share_ids", "current_share_ids", "share_type", "opening_balance"];
  const beforeIds = new Set(input.beforeShares.map((share) => share.shareId));
  const currentIds = new Set(input.currentShares.map((share) => share.shareId));
  if (beforeIds.size !== input.beforeShares.length || currentIds.size !== input.currentShares.length) {
    return decision("still_unknown", "Duplicate share identifiers prevented a unique comparison.", checked);
  }
  const removed = input.beforeShares.filter((share) => !currentIds.has(share.shareId));
  const added = input.currentShares.filter((share) => !beforeIds.has(share.shareId));
  if (
    removed.length === 0 && added.length === 1 &&
    added[0]!.type === input.expectedType &&
    added[0]!.balanceMinor === input.expectedOpeningBalanceMinor
  ) {
    return decision("applied", "Exactly one new share matches the reviewed type and opening balance.", checked);
  }
  if (removed.length === 0 && added.length === 0) {
    return decision("not_applied", "The current share identifiers are unchanged from the pre-commit snapshot.", checked);
  }
  return decision("still_unknown", "The share set changed without one unique exact match to the reviewed request.", checked);
}

export interface MemberContactMarker {
  readonly email: string;
  readonly phone: string;
  readonly address: string;
}

function sameContact(left: MemberContactMarker, right: MemberContactMarker): boolean {
  return left.email === right.email && left.phone === right.phone && left.address === right.address;
}

export function reconcileMemberUpdate(input: {
  readonly before: MemberContactMarker;
  readonly requested: MemberContactMarker;
  readonly current?: MemberContactMarker;
}): ReconciliationDecision {
  const checked = ["email", "phone", "address", "pre_commit_values"];
  if (!input.current) {
    return decision("still_unknown", "The current member contact fields could not all be read.", checked);
  }
  if (sameContact(input.current, input.requested)) {
    return decision("applied", "All current contact fields equal the exact reviewed values.", checked);
  }
  if (!sameContact(input.before, input.requested) && sameContact(input.current, input.before)) {
    return decision("not_applied", "All contact fields remain at their bound pre-commit values.", checked);
  }
  return decision("still_unknown", "The current contact fields match neither the complete before nor requested state.", checked);
}

export function reconcileAccountHold(input: {
  readonly shareId: string;
  readonly beforeStatus: string;
  readonly currentShare?: { readonly shareId: string; readonly status: string };
}): ReconciliationDecision {
  const checked = ["share_id", "before_status", "current_status"];
  if (!input.currentShare || input.currentShare.shareId !== input.shareId) {
    return decision("still_unknown", "The exact reviewed share could not be read.", checked);
  }
  if (input.beforeStatus !== "HOLD" && input.currentShare.status === "HOLD") {
    return decision("applied", "The exact reviewed share changed from its pre-commit status to HOLD.", checked);
  }
  if (input.beforeStatus !== "HOLD" && input.currentShare.status === input.beforeStatus) {
    return decision("not_applied", "The exact reviewed share remains at its bound pre-commit status.", checked);
  }
  return decision("still_unknown", "The prior state was already held or the current status is not decisive.", checked);
}
