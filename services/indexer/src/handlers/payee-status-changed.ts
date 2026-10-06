/** PayeeStatusChanged (all schema_versions). Roadmap M2-10. */
import { eq } from "drizzle-orm";
import { payees } from "../db/schema.js";
import { type EventHandler, InconsistentStateError, payeeKey, variant } from "./types.js";

export const payeeStatusChangedV1: EventHandler = async (db, event) => {
  const updated = await db
    .update(payees)
    .set({ status: variant(event, "status"), statusChangedAt: event.ledgerTime })
    .where(eq(payees.payeeId, payeeKey(event)))
    .returning({ payeeId: payees.payeeId });
  if (updated.length !== 1) throw new InconsistentStateError(`${event.id}: unknown payee`);
};
