/**
 * Indexer-owned tables. Source: docs/ARCHITECTURE.md §6.
 * Amounts are NUMERIC(39,0) (holds i128) and `bigint` in code.
 * `chain_events` is append-only. No receipts, private-reference, attestation, or user tables.
 * `payees.country` / `local_currency` come from registry data: filter and display only.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

const amount = (name: string) => numeric(name, { precision: 39, scale: 0, mode: "bigint" });

export const chainEvents = pgTable(
  "chain_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    eventType: text("event_type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    ledger: bigint("ledger", { mode: "bigint" }).notNull(),
    ledgerTime: timestamp("ledger_time", { withTimezone: true }).notNull(),
    txHash: text("tx_hash").notNull(),
    eventIndex: integer("event_index").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [unique("chain_events_tx_event_unique").on(t.txHash, t.eventIndex)],
);

export const indexerCursor = pgTable("indexer_cursor", {
  id: integer("id").primaryKey().default(1),
  lastLedger: bigint("last_ledger", { mode: "bigint" }).notNull(),
  lastEventId: text("last_event_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const locks = pgTable(
  "locks",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey(),
    sender: text("sender").notNull(),
    payeeId: text("payee_id").notNull(),
    /** Snapshot at creation. */
    payout: text("payout").notNull(),
    token: text("token").notNull(),
    total: amount("total").notNull(),
    released: amount("released").notNull().default(sql`0`),
    returned: amount("returned").notNull().default(sql`0`),
    refHash: text("ref_hash").notNull(),
    state: text("state").notNull(),
    /** Expired | Revoked | SuspendedTimeout | Declined */
    endReason: text("end_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    createdTx: text("created_tx").notNull(),
  },
  (t) => [
    index("locks_sender_idx").on(t.sender),
    index("locks_payee_state_idx").on(t.payeeId, t.state),
    // Duplicate-reference preflight.
    index("locks_payee_ref_hash_idx").on(t.payeeId, t.refHash),
  ],
);

export const tranches = pgTable(
  "tranches",
  {
    lockId: bigint("lock_id", { mode: "bigint" })
      .notNull()
      .references(() => locks.id),
    idx: integer("idx").notNull(),
    amount: amount("amount").notNull(),
    unlockAt: timestamp("unlock_at", { withTimezone: true }).notNull(),
    released: boolean("released").notNull().default(false),
    releaseTx: text("release_tx"),
  },
  (t) => [primaryKey({ columns: [t.lockId, t.idx] })],
);

export const payees = pgTable("payees", {
  payeeId: text("payee_id").primaryKey(),
  /** From the registry repo (M2-13); null until joined. */
  slug: text("slug").unique(),
  category: text("category").notNull(),
  status: text("status").notNull(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull(),
  payout: text("payout").notNull(),
  payoutUpdatedAt: timestamp("payout_updated_at", { withTimezone: true }),
  attester: text("attester").notNull(),
  metaHash: text("meta_hash").notNull(),
  displayName: text("display_name"),
  /** ISO 3166-1 alpha-2 from the registry repo. Filter/display only. */
  country: text("country"),
  /** ISO 4217 from the registry repo. Display only. */
  localCurrency: text("local_currency"),
  city: text("city"),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
});
