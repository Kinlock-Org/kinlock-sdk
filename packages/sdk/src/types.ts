/**
 * Off-chain mirror of the contract data model (kinlock-contracts `types.rs`).
 * Amounts and u64 values are `bigint`: never use `number` for money.
 * Once bindings exist (M1-18), these must match the generated types exactly.
 */

export type Address = string;
/** 32-byte hash as lowercase hex. */
export type Hash32 = string;

export const CATEGORIES = ["School", "Rent"] as const;
export type Category = (typeof CATEGORIES)[number];

export const PAYEE_STATUSES = ["Active", "Suspended", "Revoked"] as const;
export type PayeeStatus = (typeof PAYEE_STATUSES)[number];

export const LOCK_STATES = ["Open", "Completed", "Refunded", "Declined"] as const;
export type LockState = (typeof LOCK_STATES)[number];

export const REFUND_REASONS = ["Expired", "Revoked", "SuspendedTimeout"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export interface Payee {
  payout: Address;
  category: Category;
  status: PayeeStatus;
  statusChangedAt: bigint;
  attester: Address;
  metaHash: Hash32;
  registeredAt: bigint;
}

export interface Tranche {
  amount: bigint;
  unlockAt: bigint;
  released: boolean;
}

export interface TrancheInput {
  amount: bigint;
  unlockAt: bigint;
}

export interface Lock {
  id: bigint;
  sender: Address;
  payeeId: Hash32;
  /** Snapshot taken at creation; never changes. */
  payout: Address;
  token: Address;
  total: bigint;
  released: bigint;
  returned: bigint;
  refHash: Hash32;
  tranches: Tranche[];
  expiresAt: bigint;
  state: LockState;
  createdAt: bigint;
}
