/** PayeeRegistered (all schema_versions). Roadmap M2-10. */
import { payees } from "../db/schema.js";
import { type EventHandler, payeeKey, str, variant } from "./types.js";

export const payeeRegisteredV1: EventHandler = async (db, event) => {
  // slug, display name, country, currency and city are joined from the registry repo (M2-13).
  await db.insert(payees).values({
    payeeId: payeeKey(event),
    category: variant(event, "category"),
    status: "Active",
    statusChangedAt: event.ledgerTime,
    payout: str(event, "payout"),
    attester: str(event, "attester"),
    metaHash: str(event, "meta_hash"),
    registeredAt: event.ledgerTime,
  });
};
