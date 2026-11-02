import { beforeAll, describe, expect, it } from "vitest";
import { chainEvents, locks, tranches } from "../src/db/schema.js";
import { decodeEvent } from "../src/ingest/decode.js";
import { type IngestDeps, ingestBatch } from "../src/ingest/poller.js";
import type { RpcClient } from "../src/rpc/client.js";
import {
  CONTRACT_ID,
  fakeRpc,
  fixture,
  fixtureLocks,
  freshDb,
  START_LEDGER,
  snapshot,
} from "./helpers/fixtures.js";

function makeDeps(db: IngestDeps["db"], rpc: RpcClient = fakeRpc(fixture.events)): IngestDeps {
  return {
    db,
    rpc,
    locks: fixtureLocks(),
    contractId: CONTRACT_ID,
    startLedger: START_LEDGER,
    pageSize: 100,
  };
}

let reference: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  const { db } = await freshDb();
  await ingestBatch(makeDeps(db));
  reference = await snapshot(db);
}, 60_000);

describe("services/indexer: concurrent event ingestion and idempotency (Issue #69, Roadmap M2-10)", () => {
  it("ingests the same batch of events concurrently across 5 parallel workers without race condition or duplicate key errors", async () => {
    const { db } = await freshDb();

    // 5 concurrent workers attempting to ingest the identical batch of events at the exact same time
    const workers = Array.from({ length: 5 }, () =>
      ingestBatch(makeDeps(db, fakeRpc(fixture.events))),
    );

    const results = await Promise.all(workers);

    // Each worker reports received events; the sum of stored events across all workers equals the unique event count
    const totalStored = results.reduce((sum, r) => sum + r.stored, 0);
    const totalEventsInFixture = fixture.events.length;
    expect(totalStored).toBe(totalEventsInFixture);

    // Exactly 12 unique events exist in chain_events table
    const storedEvents = await db.select().from(chainEvents);
    expect(storedEvents).toHaveLength(totalEventsInFixture);

    // Verified: locks and tranches match reference snapshot byte-for-byte
    const current = await snapshot(db);
    expect(current).toEqual(reference);
  });

  it("handles out-of-order and interleaved concurrent ingestion idempotently", async () => {
    const { db } = await freshDb();

    // Split events into two overlapping chunks
    const chunkA = fixture.events.slice(0, 8);
    const chunkB = fixture.events.slice(4); // overlaps events 4..7

    // Run chunkA and chunkB concurrently
    const [resA, resB] = await Promise.all([
      ingestBatch(makeDeps(db, fakeRpc(chunkA))),
      ingestBatch(makeDeps(db, fakeRpc(chunkB))),
    ]);

    expect(resA.stored + resB.stored).toBe(fixture.events.length);

    // Exactly 12 events stored in chain_events
    const storedEvents = await db.select().from(chainEvents);
    expect(storedEvents).toHaveLength(fixture.events.length);

    // Replay full fixture once more over the existing database to confirm idempotent convergence
    await ingestBatch(makeDeps(db, fakeRpc(fixture.events)));

    expect(await snapshot(db)).toEqual(reference);
  });

  it("prevents duplicate lock creation and preserves tranches integrity under concurrent execution", async () => {
    const { db } = await freshDb();

    // Extract only the events up through LockCreated
    const lockEvents = fixture.events.filter((e) => decodeEvent(e).type === "LockCreated");
    expect(lockEvents.length).toBeGreaterThan(0);

    // Ingest the lock events concurrently across 4 parallel promises
    await Promise.all([
      ingestBatch(makeDeps(db, fakeRpc(lockEvents))),
      ingestBatch(makeDeps(db, fakeRpc(lockEvents))),
      ingestBatch(makeDeps(db, fakeRpc(lockEvents))),
      ingestBatch(makeDeps(db, fakeRpc(lockEvents))),
    ]);

    const createdLocks = await db.select().from(locks);
    const createdTranches = await db.select().from(tranches);

    // Exactly 2 locks created (id 1 and 2 in fixture), no duplicates
    expect(createdLocks).toHaveLength(2);
    // Exactly 3 tranches created (2 for lock 1, 1 for lock 2)
    expect(createdTranches).toHaveLength(3);
  });
});
