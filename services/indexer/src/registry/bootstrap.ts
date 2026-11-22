/**
 * Seeds payee rows from current chain state (roadmap M2-28).
 *
 * RPC event history covers about eight days, so on a fresh database the `PayeeRegistered` events of
 * payees registered before it cannot be replayed and `/payees` would list nobody. The ids to read
 * come from the registry repo (which lists what was meant to be registered) and every field written
 * comes from the contract, so the row is chain data, not a guess; the registry join (M2-13) then
 * binds display fields to it by `meta_hash` exactly as it does for an event-derived row.
 *
 * Rows that already exist are left alone: the event pipeline owns a payee it has seen. Nothing here
 * backfills locks, and a missing payee is reported, never invented.
 */
import type { Db } from "../db/client.js";
import { payees } from "../db/schema.js";
import { fromUnix } from "../handlers/types.js";
import type { ChainPayee, PayeeReader } from "../rpc/payees.js";
import { readRegistry } from "./sync.js";

export interface BootstrapResult {
  /** payee_ids inserted from chain state. */
  seeded: string[];
  /** Registry payees with no row, each with the reason it wasn't seeded. */
  skipped: { payeeId: string; reason: string }[];
}

export async function bootstrapPayees(
  db: Db,
  registryRoot: string,
  reader: PayeeReader,
): Promise<BootstrapResult> {
  const { entries } = readRegistry(registryRoot);
  const existing = new Set(
    (await db.select({ payeeId: payees.payeeId }).from(payees)).map((row) => row.payeeId),
  );
  const seeded: string[] = [];
  const skipped: BootstrapResult["skipped"] = [];

  for (const payeeId of [...entries.keys()].sort()) {
    if (existing.has(payeeId)) continue;
    let chain: ChainPayee | undefined;
    try {
      chain = await reader.read(payeeId);
    } catch (e) {
      skipped.push({ payeeId, reason: (e as Error).message });
      continue;
    }
    if (!chain) {
      skipped.push({ payeeId, reason: "not registered on this contract" });
      continue;
    }
    await db
      .insert(payees)
      .values({
        payeeId,
        category: chain.category,
        status: chain.status,
        statusChangedAt: fromUnix(chain.statusChangedAt),
        payout: chain.payout,
        attester: chain.attester,
        metaHash: chain.metaHash,
        registeredAt: fromUnix(chain.registeredAt),
      })
      .onConflictDoNothing();
    seeded.push(payeeId);
  }
  return { seeded, skipped };
}
