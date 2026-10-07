/**
 * Typed contract of the list API (roadmap M2-12). Every response is indexer data: it can lag the
 * chain, so it is labeled `source: "indexer"` with the ledger it reflects. Money-moving pages must
 * re-read the chain (ARCHITECTURE.md §3, hard rule 3).
 * Amounts are decimal strings in base units (7 decimals for USDC); times are ISO 8601 UTC.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

const address = z
  .string()
  .refine((s) => StrKey.isValidEd25519PublicKey(s) || StrKey.isValidContract(s), "invalid address");
const hex32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 32 bytes as lowercase hex");
/** A lock id: u64 as a decimal string. */
const lockId = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .transform(BigInt)
  .refine((n) => n < 2n ** 64n, "out of range");

export const LOCK_STATES = ["Open", "Completed", "Refunded", "Declined"] as const;
export const CATEGORIES = ["School", "Rent"] as const;
export const MAX_LIMIT = 100;

const limit = z.coerce.number().int().min(1).max(MAX_LIMIT).default(50);

export const LocksQuery = z.object({
  sender: address.optional(),
  payee_id: hex32.optional(),
  /** Locks with this reference hash (duplicate-reference preflight, with payee_id). */
  ref_hash: hex32.optional(),
  state: z.enum(LOCK_STATES).optional(),
  limit,
  /** Return locks with an id lower than this (newest first). Use `next` from the previous page. */
  before: lockId.optional(),
});

export const LockParams = z.object({ id: lockId });

export const EventParams = z.object({
  txHash: hex32,
  eventIndex: z.coerce
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
});

export const PayeesQuery = z.object({
  /** One payee by its on-chain id (preflight's recent-payout-change check). */
  payee_id: hex32.optional(),
  category: z.enum(CATEGORIES).optional(),
  /** ISO 3166-1 alpha-2, from registry data. Filter only. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  /** Case-insensitive match on display name or slug. */
  q: z.string().trim().min(1).max(100).optional(),
  limit,
  /** Return payees whose payee_id sorts after this. Use `next` from the previous page. */
  after: hex32.optional(),
});

export interface Tranche {
  idx: number;
  amount: string;
  unlockAt: string;
  released: boolean;
  releaseTx: string | null;
}

export interface Lock {
  id: string;
  sender: string;
  payeeId: string;
  /** Payout snapshot taken at creation; never changes. */
  payout: string;
  token: string;
  total: string;
  released: string;
  returned: string;
  refHash: string;
  state: (typeof LOCK_STATES)[number];
  /** Expired | Revoked | SuspendedTimeout | Declined, once the lock is settled that way. */
  endReason: string | null;
  expiresAt: string;
  createdAt: string;
  createdTx: string;
}

/** Registry fields (slug through city, attesterHandle) are null unless the registry file is
 *  hash-bound to the on-chain registration; see registry/sync.ts. */
export interface Payee {
  payeeId: string;
  slug: string | null;
  displayName: string | null;
  category: (typeof CATEGORIES)[number];
  status: "Active" | "Suspended" | "Revoked";
  statusChangedAt: string;
  payout: string;
  payoutUpdatedAt: string | null;
  attester: string;
  /** Registry handle of the attester; null unless its file names the on-chain address. */
  attesterHandle: string | null;
  metaHash: string;
  country: string | null;
  localCurrency: string | null;
  city: string | null;
  registeredAt: string;
}

/** Every list and detail response carries where it came from and how fresh it is. */
export interface IndexerMeta {
  source: "indexer";
  /** Last ledger the indexer has processed; null before the first batch. */
  indexedLedger: number | null;
}

export type LocksResponse = IndexerMeta & { locks: Lock[]; next: string | null };
export type LockResponse = IndexerMeta & { lock: Lock & { tranches: Tranche[] } };
/** A stored contract event. `payload` holds `key` (lock id or payee id) and the event's fields,
 *  with integers as decimal strings. */
export interface ChainEvent {
  type: string;
  schemaVersion: number;
  ledger: number;
  ledgerTime: string;
  txHash: string;
  eventIndex: number;
  payload: Record<string, unknown>;
}

export type EventResponse = IndexerMeta & { event: ChainEvent };
export type PayeesResponse = IndexerMeta & { payees: Payee[]; next: string | null };

export interface HealthResponse {
  status: "ok" | "lagging" | "unknown";
  indexedLedger: number | null;
  latestLedger: number | null;
  /** latestLedger - indexedLedger. */
  lagLedgers: number | null;
  /** When the indexer last committed a batch. */
  lastBatchAt: string | null;
}
