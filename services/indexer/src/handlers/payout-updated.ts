/** PayoutUpdated (all schema_versions). Existing locks keep their snapshot. Roadmap M2-10. */
import { eq } from "drizzle-orm";
import { payees } from "../db/schema.js";
import { type EventHandler, InconsistentStateError, payeeKey, str } from "./types.js";

export const payoutUpdatedV1: EventHandler = async (db, event) => {
  const updated = await db
    .update(payees)
    .set({ payout: str(event, "new_payout"), payoutUpdatedAt: event.ledgerTime })
    .where(eq(payees.payeeId, payeeKey(event)))
    .returning({ payeeId: payees.payeeId });
  if (updated.length !== 1) throw new InconsistentStateError(`${event.id}: unknown payee`);
};
