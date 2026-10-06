/** Released (all schema_versions). Roadmap M2-10. */
import { and, eq } from "drizzle-orm";
import { locks, tranches } from "../db/schema.js";
import { openLock, remainder } from "./settle.js";
import { type EventHandler, InconsistentStateError, int, lockKey } from "./types.js";

export const releasedV1: EventHandler = async (db, event) => {
  const id = lockKey(event);
  const idx = Number(int(event, "idx"));
  const amount = int(event, "amount");
  const lock = await openLock(db, event, id);
  if (amount <= 0n || amount > remainder(lock)) {
    throw new InconsistentStateError(`${event.id}: release of ${amount} exceeds lock ${id}`);
  }
  const marked = await db
    .update(tranches)
    .set({ released: true, releaseTx: event.txHash })
    .where(
      and(
        eq(tranches.lockId, id),
        eq(tranches.idx, idx),
        eq(tranches.released, false),
        eq(tranches.amount, amount),
      ),
    )
    .returning({ idx: tranches.idx });
  if (marked.length !== 1) {
    throw new InconsistentStateError(`${event.id}: tranche ${idx} of lock ${id} doesn't match`);
  }
  const released = lock.released + amount;
  await db
    .update(locks)
    .set({ released, state: released === lock.total ? "Completed" : "Open" })
    .where(eq(locks.id, id));
};
