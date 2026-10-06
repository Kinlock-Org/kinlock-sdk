import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../../src/db/client.js";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations.js";
import * as schema from "../../src/db/schema.js";
import type { TrancheSchedule } from "../../src/handlers/types.js";
import type { EventsPage, EventsQuery, RpcClient, RpcEvent } from "../../src/rpc/client.js";
import type { LockReader } from "../../src/rpc/locks.js";

interface Fixture {
  events: RpcEvent[];
  tranches: Record<string, { amount: string; unlock_at: number }[]>;
}

export const fixture: Fixture = JSON.parse(
  readFileSync(new URL("../fixtures/events/testnet-2026-10-06.json", import.meta.url), "utf8"),
);
export const CONTRACT_ID = fixture.events[0]?.contractId ?? "";
export const START_LEDGER = 5052300;
/** Copy of kinlock-registry/fixtures (payees and attesters) as registered on testnet. */
export const REGISTRY_FIXTURES = fileURLToPath(new URL("../fixtures/registry", import.meta.url));

let shared: Promise<Db> | undefined;

/** One in-memory Postgres per test file with the real migrations applied (startup is slow). */
async function migratedDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db as unknown as Db;
}

/** The shared database, emptied. */
export async function freshDb(): Promise<{ db: Db }> {
  shared ??= migratedDb();
  const db = await shared;
  await db.execute(
    sql`TRUNCATE chain_events, indexer_cursor, tranches, locks, payees RESTART IDENTITY`,
  );
  return { db };
}

/** End-of-ledger paging cursor, as RPC returns after an incomplete page. */
const endCursor = (ledger: number) =>
  `${((BigInt(ledger + 1) << 32n) - 1n).toString().padStart(19, "0")}-4294967295`;

/** An in-memory getEvents with RPC's paging semantics over a fixed event list. */
export function fakeRpc(
  events: RpcEvent[],
  opts: { oldestLedger?: number; latestLedger?: number } = {},
): RpcClient & { calls: EventsQuery[] } {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : 1));
  const latestLedger = opts.latestLedger ?? Math.max(...sorted.map((e) => e.ledger)) + 5;
  const oldestLedger = opts.oldestLedger ?? START_LEDGER - 1000;
  const calls: EventsQuery[] = [];
  return {
    calls,
    async getLatestLedger() {
      return latestLedger;
    },
    async getEvents(query): Promise<EventsPage> {
      calls.push(query);
      const after =
        "cursor" in query
          ? sorted.filter((e) => e.id > query.cursor)
          : sorted.filter((e) => e.ledger >= query.startLedger);
      const events = after.slice(0, query.limit);
      const last = events[events.length - 1];
      const cursor = events.length === query.limit && last ? last.id : endCursor(latestLedger);
      return { events, cursor, latestLedger, oldestLedger };
    },
  };
}

export function fixtureLocks(): LockReader & { reads: bigint[] } {
  const reads: bigint[] = [];
  return {
    reads,
    async tranches(lockId): Promise<TrancheSchedule[]> {
      reads.push(lockId);
      const t = fixture.tranches[lockId.toString()];
      if (!t) throw new Error(`no fixture tranches for lock ${lockId}`);
      return t.map((x) => ({ amount: BigInt(x.amount), unlockAt: BigInt(x.unlock_at) }));
    },
  };
}

/** Every table, ordered, for whole-database comparisons. */
export async function snapshot(db: Db) {
  const { chainEvents, locks, payees, tranches } = schema;
  return {
    chainEvents: (
      await db.select().from(chainEvents).orderBy(chainEvents.ledger, chainEvents.txHash)
    ).map(({ id: _, ...rest }) => rest),
    locks: await db.select().from(locks).orderBy(locks.id),
    tranches: await db.select().from(tranches).orderBy(tranches.lockId, tranches.idx),
    payees: await db.select().from(payees).orderBy(payees.payeeId),
  };
}
