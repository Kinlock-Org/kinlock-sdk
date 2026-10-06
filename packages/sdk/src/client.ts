/**
 * Contract client over the generated bindings. Roadmap M2-02.
 * `getLock` reads CHAIN state and is the only read money-moving pages may use.
 */
import { NotImplementedError } from "./errors.js";
import type { Address, Hash32, Lock, TrancheInput } from "./types.js";

export interface CreateLockParams {
  sender: Address;
  token: Address;
  payeeId: Hash32;
  tranches: TrancheInput[];
  refHash: Hash32;
  expiresAt: bigint;
}

export async function createLock(
  _params: CreateLockParams,
): Promise<{ lockId: bigint; txHash: string }> {
  throw new NotImplementedError("createLock", "M2-02");
}

export async function release(_lockId: bigint, _trancheIndex: number): Promise<{ txHash: string }> {
  throw new NotImplementedError("release", "M2-02");
}

export async function refund(_lockId: bigint): Promise<{ txHash: string }> {
  throw new NotImplementedError("refund", "M2-02");
}

export async function decline(_lockId: bigint): Promise<{ txHash: string }> {
  throw new NotImplementedError("decline", "M2-02");
}

/** Chain read. Never backed by the indexer. */
export async function getLock(_lockId: bigint): Promise<Lock | null> {
  throw new NotImplementedError("getLock", "M2-02");
}
