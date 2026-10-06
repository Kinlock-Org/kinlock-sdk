/** Shared lock bookkeeping for Released, Refunded and Declined. Roadmap M2-10. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { locks } from "../db/schema.js";
import { type DecodedEvent, InconsistentStateError } from "./types.js";

type Lock = typeof locks.$inferSelect;

export async function openLock(db: Db, event: DecodedEvent, id: bigint): Promise<Lock> {
  const [lock] = await db.select().from(locks).where(eq(locks.id, id));
  if (!lock) throw new InconsistentStateError(`${event.id}: unknown lock ${id}`);
  if (lock.state !== "Open") {
    throw new InconsistentStateError(`${event.id}: lock ${id} is ${lock.state}, not Open`);
  }
  return lock;
}

/** Remainder still held for the lock; an event moving more than this is inconsistent. */
export function remainder(lock: Lock): bigint {
  return lock.total - lock.released - lock.returned;
}
