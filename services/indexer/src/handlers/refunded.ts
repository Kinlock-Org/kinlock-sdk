/** Refunded (all schema_versions). Roadmap M2-10. */
import { eq } from "drizzle-orm";
import { locks } from "../db/schema.js";
import { openLock, remainder } from "./settle.js";
import { type EventHandler, InconsistentStateError, int, lockKey, variant } from "./types.js";

export const refundedV1: EventHandler = async (db, event) => {
  const id = lockKey(event);
  const amount = int(event, "amount");
  const lock = await openLock(db, event, id);
  if (amount !== remainder(lock)) {
    throw new InconsistentStateError(
      `${event.id}: refund of ${amount} isn't lock ${id}'s remainder`,
    );
  }
  await db
    .update(locks)
    .set({
      returned: lock.returned + amount,
      state: "Refunded",
      // Expired | Revoked | SuspendedTimeout
      endReason: variant(event, "reason"),
    })
    .where(eq(locks.id, id));
};
