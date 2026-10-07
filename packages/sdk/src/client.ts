/**
 * Contract client over the generated bindings (`@kinlock/contract`). Roadmap M2-02.
 *
 * Flow for writes (ARCHITECTURE.md §5.2): build → simulate → the wallet signs → submit → wait.
 * The SDK never holds keys: every write takes a `Signer` whose `signTransaction` is the wallet's.
 * The contract decides who must sign: `createLock` and `refund` the sender, `release` and
 * `decline` the lock's payout address.
 *
 * `getLock` reads CHAIN state and is the only read money-moving pages may use.
 */
import { Client, type Lock as RawLock, type Payee as RawPayee } from "@kinlock/contract";
import { StrKey } from "@stellar/stellar-sdk";
import type { AssembledTransaction, Result, SignTransaction } from "@stellar/stellar-sdk/contract";
import { Buffer } from "buffer";
import { KinlockError } from "./errors.js";
import type {
  Address,
  Category,
  Hash32,
  Lock,
  LockState,
  Payee,
  PayeeStatus,
  TrancheInput,
} from "./types.js";

/** Which network and contract to talk to. */
export interface KinlockConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** The Kinlock contract (C… address). */
  contractId: Address;
  /** Allow a plain-http RPC URL (local networks only). */
  allowHttp?: boolean;
  /** Kinlock list API, for preflight's indexer-backed warnings only. Never used for money pages. */
  indexerUrl?: string;
}

/** The account that signs, and the wallet function that signs for it. */
export interface Signer {
  address: Address;
  /** Same shape as Stellar Wallets Kit's `signTransaction`. */
  signTransaction: SignTransaction;
}

export interface CreateLockParams {
  sender: Address;
  token: Address;
  payeeId: Hash32;
  tranches: TrancheInput[];
  refHash: Hash32;
  /** Unix seconds. */
  expiresAt: bigint;
}

const U64_MAX = 2n ** 64n - 1n;

const invalid = (message: string) => new KinlockError(message, "INVALID_INPUT");

function checkAddress(value: string, field: string): void {
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    throw invalid(`${field} is not a valid Stellar address`);
  }
}

function checkHash(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(`${field} must be 32 bytes as lowercase hex`);
}

function checkU64(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw invalid(`${field} must be a u64 bigint`);
  }
}

function checkConfig(config: KinlockConfig): void {
  if (!StrKey.isValidContract(config.contractId)) throw invalid("contractId must be a C… address");
}

function contractClient(config: KinlockConfig, publicKey?: Address): Client {
  checkConfig(config);
  return new Client({
    contractId: config.contractId,
    networkPassphrase: config.networkPassphrase,
    rpcUrl: config.rpcUrl,
    allowHttp: config.allowHttp ?? false,
    ...(publicKey ? { publicKey } : {}),
  });
}

/** Contract errors arrive as "Name: explanation" (the error's doc comment). */
function contractError(message: string): KinlockError {
  const name = message.split(":")[0]?.trim() || "Unknown";
  return new KinlockError(message, "CONTRACT_ERROR", name);
}

async function signAndSend<T>(
  tx: AssembledTransaction<Result<T>>,
  signer: Signer,
): Promise<{ value: T; txHash: string }> {
  // The simulation already ran; a contract error there means the call can't succeed.
  if (tx.result.isErr()) throw contractError(tx.result.unwrapErr().message);
  let sent: Awaited<ReturnType<typeof tx.signAndSend>>;
  try {
    sent = await tx.signAndSend({ signTransaction: signer.signTransaction });
  } catch (e) {
    throw new KinlockError(`transaction failed: ${(e as Error).message}`, "TX_FAILED");
  }
  const result = sent.result;
  if (result.isErr()) throw contractError(result.unwrapErr().message);
  const txHash = sent.sendTransactionResponse?.hash;
  if (!txHash) throw new KinlockError("transaction sent but no hash was returned", "TX_FAILED");
  return { value: result.unwrap(), txHash };
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const bytes32 = (value: Hash32): Buffer => Buffer.from(value, "hex");

function toLock(raw: RawLock): Lock {
  return {
    id: raw.id,
    sender: raw.sender,
    payeeId: hex(raw.payee_id),
    payout: raw.payout,
    token: raw.token,
    total: raw.total,
    released: raw.released,
    returned: raw.returned,
    refHash: hex(raw.ref_hash),
    tranches: raw.tranches.map((t) => ({
      amount: t.amount,
      unlockAt: t.unlock_at,
      released: t.released,
    })),
    expiresAt: raw.expires_at,
    state: raw.state.tag as LockState,
    createdAt: raw.created_at,
  };
}

export async function createLock(
  config: KinlockConfig,
  params: CreateLockParams,
  signer: Signer,
): Promise<{ lockId: bigint; txHash: string }> {
  checkAddress(params.sender, "sender");
  checkAddress(params.token, "token");
  checkHash(params.payeeId, "payeeId");
  checkHash(params.refHash, "refHash");
  checkU64(params.expiresAt, "expiresAt");
  if (params.sender !== signer.address) throw invalid("the signer must be the sender");
  if (params.tranches.length === 0) throw invalid("at least one tranche is required");
  for (const [i, t] of params.tranches.entries()) {
    if (typeof t.amount !== "bigint" || t.amount <= 0n) {
      throw invalid(`tranche ${i}: amount must be a positive bigint`);
    }
    checkU64(t.unlockAt, `tranche ${i} unlockAt`);
  }
  const tx = await contractClient(config, signer.address).create_lock({
    sender: params.sender,
    token: params.token,
    payee_id: bytes32(params.payeeId),
    tranches: params.tranches.map((t) => ({ amount: t.amount, unlock_at: t.unlockAt })),
    ref_hash: bytes32(params.refHash),
    expires_at: params.expiresAt,
  });
  const { value, txHash } = await signAndSend(tx, signer);
  return { lockId: value, txHash };
}

/** The payee (the lock's payout address) claims an unlocked tranche. */
export async function release(
  config: KinlockConfig,
  params: { lockId: bigint; trancheIndex: number },
  signer: Signer,
): Promise<{ txHash: string }> {
  checkU64(params.lockId, "lockId");
  if (!Number.isInteger(params.trancheIndex) || params.trancheIndex < 0) {
    throw invalid("trancheIndex must be a non-negative integer");
  }
  const tx = await contractClient(config, signer.address).release({
    lock_id: params.lockId,
    idx: params.trancheIndex,
  });
  return { txHash: (await signAndSend(tx, signer)).txHash };
}

/** The sender takes back the unreleased remainder (after expiry, or payee Revoked/Suspended). */
export async function refund(
  config: KinlockConfig,
  params: { lockId: bigint },
  signer: Signer,
): Promise<{ txHash: string }> {
  checkU64(params.lockId, "lockId");
  const tx = await contractClient(config, signer.address).refund({ lock_id: params.lockId });
  return { txHash: (await signAndSend(tx, signer)).txHash };
}

/** The payee returns the unreleased remainder to the sender. */
export async function decline(
  config: KinlockConfig,
  params: { lockId: bigint },
  signer: Signer,
): Promise<{ txHash: string }> {
  checkU64(params.lockId, "lockId");
  const tx = await contractClient(config, signer.address).decline({ lock_id: params.lockId });
  return { txHash: (await signAndSend(tx, signer)).txHash };
}

/** Chain read (simulation; nothing is signed or sent). Never backed by the indexer. */
export async function getLock(config: KinlockConfig, lockId: bigint): Promise<Lock | null> {
  checkU64(lockId, "lockId");
  const tx = await contractClient(config).get_lock({ lock_id: lockId });
  if (tx.result.isErr()) {
    const error = contractError(tx.result.unwrapErr().message);
    if (error.contractError === "LockNotFound") return null;
    throw error;
  }
  return toLock(tx.result.unwrap());
}

function toPayee(raw: RawPayee): Payee {
  return {
    payout: raw.payout,
    category: raw.category.tag as Category,
    status: raw.status.tag as PayeeStatus,
    statusChangedAt: raw.status_changed_at,
    attester: raw.attester,
    metaHash: hex(raw.meta_hash),
    registeredAt: raw.registered_at,
  };
}

/**
 * Chain read of a registered payee (simulation; nothing is signed or sent). `null` if the payee
 * isn't registered. Money pages use it for the refund rule (Revoked, or Suspended past grace);
 * never backed by the indexer. ADR-0030.
 */
export async function getPayee(config: KinlockConfig, payeeId: Hash32): Promise<Payee | null> {
  checkHash(payeeId, "payeeId");
  const tx = await contractClient(config).get_payee({ payee_id: bytes32(payeeId) });
  if (tx.result.isErr()) {
    const error = contractError(tx.result.unwrapErr().message);
    if (error.contractError === "PayeeNotFound") return null;
    throw error;
  }
  return toPayee(tx.result.unwrap());
}
