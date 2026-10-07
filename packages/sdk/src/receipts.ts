/**
 * Receipt verification from chain data, never the database. Roadmap M2-06 (tiers 1-2), M2-16 (tier 3).
 * Receipt URL: `/r/{txHash}/{eventIndex}`. Wording: "Payment to verified payee".
 *
 * Tier 1 (`live_rpc`): the transaction is still within RPC retention. Its events are read from RPC
 * and the receipt is valid only if that exact event was emitted by the Kinlock contract in a
 * successful call and is a Released, Refunded or Declined event of a known schema version. Every
 * detail returned comes from that event.
 * Tier 2 (`lock_state`): the transaction is older than RPC retention. The indexer is asked which
 * lock and tranche the event refers to (a lookup aid only), and `get_lock` must confirm it on chain:
 * the tranche released with that amount, or the lock refunded / declined for that amount.
 * Payment is confirmed; transaction details are not.
 * Tier 3 (`archive`) needs an archive provider (M0-09, M2-16); until then older receipts whose
 * lock entry is gone report `unverifiable`, never valid.
 */
import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { z } from "zod";
import { getLock, type KinlockConfig } from "./client.js";
import { KinlockError } from "./errors.js";
import type { Address, RefundReason } from "./types.js";

export type VerificationTier = "live_rpc" | "lock_state" | "archive";

export type ReceiptKind = "Released" | "Refunded" | "Declined";

export interface ReceiptRef {
  txHash: string;
  eventIndex: number;
}

/** What the chain confirms. Fields not confirmed by the tier used are absent. */
export interface VerifiedReceipt {
  lockId: bigint;
  amount: bigint;
  /** Released only. */
  trancheIndex?: number;
  /** Released only: the lock's payout snapshot that received the funds. */
  payout?: Address;
  /** Refunded only. */
  refundReason?: RefundReason;
  /** Tier 1 only: when the transaction's ledger closed (ISO 8601 UTC). */
  ledgerTime?: string;
}

export type VerifyReceiptReason =
  | "verified"
  /** No Kinlock receipt event at this transaction and index. */
  | "not_found"
  /** The chain contradicts what the receipt claims (e.g. the tranche isn't released). */
  | "mismatch"
  /** Too old for RPC and no way to confirm on chain yet (needs tier 3, or no indexer). */
  | "unverifiable";

export interface VerifyReceiptResult {
  valid: boolean;
  tier: VerificationTier | null;
  kind: ReceiptKind | null;
  reason: VerifyReceiptReason;
  receipt: VerifiedReceipt | null;
}

const KINDS: Record<string, ReceiptKind> = {
  released: "Released",
  refunded: "Refunded",
  declined: "Declined",
};
/** Event schema versions this SDK understands (kinlock-contracts `EVENT_SCHEMA_VERSION`). */
const KNOWN_SCHEMA_VERSIONS = new Set([1]);

const outcome = (
  reason: VerifyReceiptReason,
  extra: Partial<VerifyReceiptResult> = {},
): VerifyReceiptResult => ({
  valid: reason === "verified",
  tier: null,
  kind: null,
  receipt: null,
  reason,
  ...extra,
});

function checkRef(ref: ReceiptRef): void {
  if (!/^[0-9a-f]{64}$/.test(ref.txHash)) {
    throw new KinlockError("txHash must be 32 bytes as lowercase hex", "INVALID_INPUT");
  }
  if (!Number.isInteger(ref.eventIndex) || ref.eventIndex < 0) {
    throw new KinlockError("eventIndex must be a non-negative integer", "INVALID_INPUT");
  }
}

const EventFields = z.object({
  schema_version: z.number().int(),
  amount: z.bigint(),
  idx: z.number().int().optional(),
  payout: z.string().optional(),
  reason: z.array(z.string()).length(1).optional(),
});

/** Tier 1. Returns null when the transaction is outside RPC retention (or never existed). */
async function liveRpc(
  config: KinlockConfig,
  ref: ReceiptRef,
): Promise<VerifyReceiptResult | null> {
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp ?? false });
  const tx = await server.getTransaction(ref.txHash);
  if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return null;
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) return outcome("not_found");

  const { events } = await server.getEvents({
    startLedger: tx.ledger,
    endLedger: tx.ledger + 1,
    filters: [{ type: "contract", contractIds: [config.contractId] }],
    limit: 1000,
  });
  const event = events.find(
    (e) => e.txHash === ref.txHash && Number(e.id.split("-")[1]) === ref.eventIndex,
  );
  if (event?.inSuccessfulContractCall !== true) return outcome("not_found");

  const [nameTopic, keyTopic] = event.topic;
  const kind = nameTopic ? KINDS[String(scValToNative(nameTopic))] : undefined;
  const lockId = keyTopic ? scValToNative(keyTopic) : undefined;
  const fields = EventFields.safeParse(scValToNative(event.value));
  if (!kind || typeof lockId !== "bigint" || !fields.success) return outcome("not_found");
  if (!KNOWN_SCHEMA_VERSIONS.has(fields.data.schema_version)) return outcome("not_found");

  const f = fields.data;
  return outcome("verified", {
    tier: "live_rpc",
    kind,
    receipt: {
      lockId,
      amount: f.amount,
      ...(kind === "Released" && f.idx !== undefined ? { trancheIndex: f.idx } : {}),
      ...(kind === "Released" && f.payout ? { payout: f.payout } : {}),
      ...(kind === "Refunded" && f.reason ? { refundReason: f.reason[0] as RefundReason } : {}),
      ledgerTime: new Date(event.ledgerClosedAt).toISOString(),
    },
  });
}

const IndexedEvent = z.object({
  event: z.object({
    type: z.string(),
    txHash: z.string(),
    eventIndex: z.number().int(),
    payload: z.object({
      key: z.string().regex(/^\d+$/),
      amount: z.string().regex(/^\d+$/),
      idx: z.number().int().optional(),
    }),
  }),
});

/** Tier 2: indexer says which lock/tranche; `get_lock` must confirm it. */
async function lockState(config: KinlockConfig, ref: ReceiptRef): Promise<VerifyReceiptResult> {
  if (!config.indexerUrl) return outcome("unverifiable");
  const response = await fetch(
    new URL(`/events/${ref.txHash}/${ref.eventIndex}`, config.indexerUrl),
    {
      headers: { accept: "application/json" },
    },
  );
  if (response.status === 404) return outcome("not_found");
  if (!response.ok) return outcome("unverifiable");
  const parsed = IndexedEvent.safeParse(await response.json());
  if (!parsed.success) return outcome("unverifiable");
  const { event } = parsed.data;
  const kind = event.type as ReceiptKind;
  if (event.txHash !== ref.txHash || event.eventIndex !== ref.eventIndex)
    return outcome("unverifiable");
  if (!["Released", "Refunded", "Declined"].includes(kind)) return outcome("not_found");

  const lockId = BigInt(event.payload.key);
  const amount = BigInt(event.payload.amount);
  const lock = await getLock(config, lockId);
  // The lock entry has expired from chain state: only an archive could confirm it (tier 3).
  if (!lock) return outcome("unverifiable", { kind });

  if (kind === "Released") {
    const idx = event.payload.idx;
    const tranche = idx === undefined ? undefined : lock.tranches[idx];
    if (idx === undefined || !tranche?.released || tranche.amount !== amount) {
      return outcome("mismatch", { kind });
    }
    return outcome("verified", {
      tier: "lock_state",
      kind,
      receipt: { lockId, amount, trancheIndex: idx, payout: lock.payout },
    });
  }
  // A refund or decline returns the whole remainder and ends the lock.
  if (lock.state !== kind || lock.returned !== amount) return outcome("mismatch", { kind });
  return outcome("verified", { tier: "lock_state", kind, receipt: { lockId, amount } });
}

/**
 * Verify a receipt from chain data. Throws only on invalid input; anything the chain can't
 * confirm is `valid: false` with a reason, never an exception the page must interpret.
 */
export async function verifyReceipt(
  config: KinlockConfig,
  ref: ReceiptRef,
): Promise<VerifyReceiptResult> {
  checkRef(ref);
  try {
    return (await liveRpc(config, ref)) ?? (await lockState(config, ref));
  } catch (e) {
    if (e instanceof KinlockError && e.code === "INVALID_INPUT") throw e;
    return outcome("unverifiable");
  }
}
