/** Persisted cursor (`indexer_cursor`). Saved in the same transaction as each batch. Roadmap M2-09. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { indexerCursor } from "../db/schema.js";

export interface Cursor {
  /** Last ledger fully scanned. */
  lastLedger: bigint;
  /** RPC paging cursor to resume from. */
  lastEventId: string | null;
}

export async function readCursor(db: Db): Promise<Cursor | null> {
  const [row] = await db.select().from(indexerCursor).where(eq(indexerCursor.id, 1));
  return row ? { lastLedger: row.lastLedger, lastEventId: row.lastEventId } : null;
}

export async function saveCursor(db: Db, cursor: Cursor): Promise<void> {
  const values = { ...cursor, updatedAt: new Date() };
  await db
    .insert(indexerCursor)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: indexerCursor.id, set: values });
}
