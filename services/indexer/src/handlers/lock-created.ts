/** LockCreated (all schema_versions). Tranches come from a get_lock chain read. Roadmap M2-10. */
import { locks, tranches } from "../db/schema.js";
import { type EventHandler, fromUnix, InconsistentStateError, int, lockKey, str } from "./types.js";

export const lockCreatedV1: EventHandler = async (db, event, ctx) => {
  const id = lockKey(event);
  const total = int(event, "total");
  const schedule = ctx.tranches.get(id);
  if (!schedule || BigInt(schedule.length) !== int(event, "tranche_count")) {
    throw new InconsistentStateError(`${event.id}: tranche schedule for lock ${id} missing`);
  }
  if (schedule.reduce((sum, t) => sum + t.amount, 0n) !== total) {
    throw new InconsistentStateError(`${event.id}: tranches of lock ${id} don't sum to total`);
  }
  await db.insert(locks).values({
    id,
    sender: str(event, "sender"),
    payeeId: str(event, "payee_id"),
    payout: str(event, "payout"),
    token: str(event, "token"),
    total,
    refHash: str(event, "ref_hash"),
    state: "Open",
    expiresAt: fromUnix(int(event, "expires_at")),
    createdAt: event.ledgerTime,
    createdTx: event.txHash,
  });
  await db.insert(tranches).values(
    schedule.map((t, idx) => ({
      lockId: id,
      idx,
      amount: t.amount,
      unlockAt: fromUnix(t.unlockAt),
    })),
  );
};
