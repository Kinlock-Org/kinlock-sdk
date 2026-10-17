import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { chainEvents, indexerCursor, locks, payees, tranches } from "../src/db/schema.js";
import { InconsistentStateError, UnsupportedEventError } from "../src/handlers/types.js";
import { DecodeError } from "../src/ingest/decode.js";
import { GapError, type IngestDeps, ingestBatch } from "../src/ingest/poller.js";
import type { RpcClient, RpcEvent } from "../src/rpc/client.js";
import {
  CONTRACT_ID,
  fakeRpc,
  fixture,
  fixtureLocks,
  freshDb,
  mixedFixture,
  mixedFixtureLocks,
  START_LEDGER,
  snapshot,
} from "./helpers/fixtures.js";

const KE = "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba";
const NG = "3e7236118c83eb3bd37927155be21cc90ada773aaca86380d28cea5f712be2f1";
const PH = "a7815d079f7663968e7ce11c3765009a09c5daccb4a123a9102d3f7567d43866";

function deps(db: Db, rpc: RpcClient = fakeRpc(fixture.events), pageSize = 3): IngestDeps {
  return {
    db,
    rpc,
    locks: fixtureLocks(),
    contractId: CONTRACT_ID,
    startLedger: START_LEDGER,
    pageSize,
  };
}

function mixedDeps(
  db: Db,
  rpc: RpcClient = fakeRpc(mixedFixture.events),
  pageSize = 3,
): IngestDeps {
  return {
    db,
    rpc,
    locks: mixedFixtureLocks(),
    contractId: CONTRACT_ID,
    startLedger: START_LEDGER,
    pageSize,
  };
}

/** Run batches until a page comes back short (caught up). */
async function drain(d: IngestDeps): Promise<number> {
  let batches = 0;
  for (;;) {
    const r = await ingestBatch(d);
    batches++;
    if (r.received < (d.pageSize ?? 100)) return batches;
  }
}

/** The real refund of lock 2 on testnet (the fixture's last event), and everything before it. */
const refundLock2 = fixture.events[fixture.events.length - 1] as RpcEvent;
const beforeRefund = fixture.events.slice(0, -1);
/** The same refund claiming one base unit more than lock 2 holds. */
const badRefund = (): RpcEvent =>
  JSON.parse(JSON.stringify(refundLock2).replace('"30000000"', '"30000001"'));

/** The database after one clean replay of all fixture events, for comparisons. */
let reference: Awaited<ReturnType<typeof snapshot>>;
let mixedReference: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  const { db } = await freshDb();
  await drain(deps(db));
  reference = await snapshot(db);

  const { db: mDb } = await freshDb();
  await drain(mixedDeps(mDb));
  mixedReference = await snapshot(mDb);
}, 60_000);

describe("ingest: replaying the recorded testnet events", () => {
  it("builds the expected locks, tranches and payees", async () => {
    const { db } = await freshDb();
    await drain(deps(db));

    expect(await db.select().from(chainEvents)).toHaveLength(12);

    const [l1, l2] = await db.select().from(locks).orderBy(locks.id);
    expect(l1).toMatchObject({
      id: 1n,
      payeeId: KE,
      total: 100000000n,
      released: 50000000n,
      returned: 50000000n,
      state: "Declined",
      endReason: "Declined",
    });
    expect(l2).toMatchObject({
      id: 2n,
      payeeId: PH,
      total: 30000000n,
      returned: 30000000n,
      state: "Refunded",
      endReason: "Expired",
    });
    expect(l2?.expiresAt.toISOString()).toBe(new Date(1791303213 * 1000).toISOString());

    const t = await db.select().from(tranches).orderBy(tranches.lockId, tranches.idx);
    expect(t.map((x) => [x.lockId, x.idx, x.amount, x.released])).toEqual([
      [1n, 0, 50000000n, true],
      [1n, 1, 50000000n, false],
      [2n, 0, 30000000n, false],
    ]);

    const p = await db.select().from(payees).orderBy(payees.payeeId);
    expect(p.map((x) => [x.payeeId, x.category, x.status])).toEqual(
      [
        [NG, "School", "Active"],
        [KE, "School", "Active"],
        [PH, "Rent", "Active"],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    );
    const ng = p.find((x) => x.payeeId === NG);
    // Payout was changed and changed back: the final value is the original one.
    expect(ng?.payout).toBe("GDPUY733T3UNZWG4EQMEBHBDGKD33YSFPOI2RB4AIK2JMOENKEXWK7ZG");
    expect(ng?.payoutUpdatedAt).not.toBeNull();
    // A payout change never touches existing locks' snapshots.
    expect(l1?.payout).toBe("GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM");
  });

  it("gives an identical database when replayed twice, from the start", async () => {
    const { db } = await freshDb();
    await drain(deps(db));
    await db.delete(indexerCursor); // force a full replay over already-stored events
    await drain(deps(db));
    expect(await snapshot(db)).toEqual(reference);
  });

  it("gives the same database whatever the page size", async () => {
    for (const size of [1, 100]) {
      const { db } = await freshDb();
      await drain(deps(db, fakeRpc(fixture.events), size));
      expect(await snapshot(db)).toEqual(reference);
    }
  });
});

describe("ingest: cursor", () => {
  it("resumes from the stored cursor after a restart", async () => {
    const { db } = await freshDb();
    const rpc1 = fakeRpc(fixture.events);
    await ingestBatch(deps(db, rpc1));
    await ingestBatch(deps(db, rpc1));
    expect(await db.select().from(chainEvents)).toHaveLength(6);

    // "Restart": new RPC client and deps, same database.
    const rpc2 = fakeRpc(fixture.events);
    await drain(deps(db, rpc2));
    expect(rpc2.calls[0]).toHaveProperty("cursor");
    expect(await snapshot(db)).toEqual(reference);
  });

  it("commits nothing, not even the cursor, when a batch fails midway", async () => {
    const { db } = await freshDb();
    const d = deps(db, fakeRpc(fixture.events), 100);
    let fail = true;
    d.locks = {
      async tranches(id) {
        if (fail) throw new Error("rpc down");
        return fixtureLocks().tranches(id);
      },
    };
    await expect(ingestBatch(d)).rejects.toThrow("rpc down");
    expect(await snapshot(db)).toEqual({ chainEvents: [], locks: [], tranches: [], payees: [] });
    expect(await db.select().from(indexerCursor)).toHaveLength(0);

    fail = false;
    await drain(d);
    expect(await snapshot(db)).toEqual(reference);
  });
});

describe("ingest: stops instead of skipping", () => {
  it("stops on a gap when the start ledger is older than RPC history", async () => {
    const { db } = await freshDb();
    const rpc = fakeRpc(fixture.events, { oldestLedger: START_LEDGER + 1 });
    await expect(ingestBatch(deps(db, rpc))).rejects.toThrow(GapError);
    expect(await db.select().from(chainEvents)).toHaveLength(0);
  });

  it("stops on a gap when the stored cursor fell out of RPC history", async () => {
    const { db } = await freshDb();
    await ingestBatch(deps(db));
    const [cursor] = await db.select().from(indexerCursor);
    const rpc = fakeRpc(fixture.events, { oldestLedger: Number(cursor?.lastLedger) + 1 });
    await expect(ingestBatch(deps(db, rpc))).rejects.toThrow(GapError);
    expect(await db.select().from(chainEvents)).toHaveLength(3);
    expect((await db.select().from(indexerCursor))[0]).toEqual(cursor);
  });

  it("stops on an unknown schema_version", async () => {
    const { db } = await freshDb();
    const bumped = fixture.events.map((e, i) =>
      i === 1
        ? {
            ...e,
            valueJson: JSON.parse(JSON.stringify(e.valueJson).replace('{"u32":1}', '{"u32":2}')),
          }
        : e,
    );
    await expect(ingestBatch(deps(db, fakeRpc(bumped)))).rejects.toThrow(UnsupportedEventError);
    expect(await db.select().from(chainEvents)).toHaveLength(0);
  });

  it("stops on an unknown event name", async () => {
    const { db } = await freshDb();
    const odd = [{ ...fixture.events[0], topicJson: [{ symbol: "mystery" }] } as RpcEvent];
    await expect(ingestBatch(deps(db, fakeRpc(odd)))).rejects.toThrow(DecodeError);
  });

  it("stops when an event contradicts stored state (refund larger than the remainder)", async () => {
    const { db } = await freshDb();
    await drain(deps(db, fakeRpc(beforeRefund)));
    await expect(ingestBatch(deps(db, fakeRpc([...beforeRefund, badRefund()])))).rejects.toThrow(
      InconsistentStateError,
    );
    const [l2] = await db.select().from(locks).where(eq(locks.id, 2n));
    expect(l2?.state).toBe("Open");
    expect(await db.select().from(chainEvents)).toHaveLength(11);
  });

  it("rolls back the whole batch when a later event in it fails", async () => {
    const { db } = await freshDb();
    const d = deps(db, fakeRpc([...beforeRefund, badRefund()]), 100);
    await expect(ingestBatch(d)).rejects.toThrow(InconsistentStateError);
    expect(await snapshot(db)).toEqual({ chainEvents: [], locks: [], tranches: [], payees: [] });
    expect(await db.select().from(indexerCursor)).toHaveLength(0);
  });
});

describe("ingest: mixed schema_versions (v1 + v2) and stop-on-unknown (M2-10, M2-14)", () => {
  it("processes a mixed v1/v2 event stream with interleaved versions on the same lock", async () => {
    const { db } = await freshDb();
    await drain(mixedDeps(db));

    // Lock 1: v1 lock_created + v1 released tranche 0 + v1 declined remainder -> state Declined
    const [l1] = await db.select().from(locks).where(eq(locks.id, 1n));
    expect(l1?.state).toBe("Declined");
    expect(l1?.total).toBe(100000000n);
    expect(l1?.released).toBe(50000000n);
    expect(l1?.returned).toBe(50000000n);

    // Lock 2: v1 lock_created + v1 refunded -> state Refunded
    const [l2] = await db.select().from(locks).where(eq(locks.id, 2n));
    expect(l2?.state).toBe("Refunded");
    expect(l2?.total).toBe(30000000n);
    expect(l2?.returned).toBe(30000000n);

    // Lock 3: created via v2, released tranche 0 via v2, released tranche 1 via v1 -> state Completed!
    const [l3] = await db.select().from(locks).where(eq(locks.id, 3n));
    expect(l3?.state).toBe("Completed");
    expect(l3?.total).toBe(80000000n);
    expect(l3?.released).toBe(80000000n);
    expect(l3?.returned).toBe(0n);

    // Verify tranches for lock 3 are both marked released without double counting
    const t3 = await db
      .select()
      .from(tranches)
      .where(eq(tranches.lockId, 3n))
      .orderBy(tranches.idx);
    expect(t3).toHaveLength(2);
    expect(t3.map((x) => [x.idx, x.amount, x.released])).toEqual([
      [0, 30000000n, true],
      [1, 50000000n, true],
    ]);

    // Verify chain_events record true schema_versions for both v1 and v2 events
    const evs = await db
      .select()
      .from(chainEvents)
      .orderBy(chainEvents.ledger, chainEvents.eventIndex);
    expect(evs).toHaveLength(mixedFixture.events.length);
    const v2Evs = evs.filter((e) => e.schemaVersion === 2);
    expect(v2Evs.length).toBeGreaterThanOrEqual(2);
    const v1Evs = evs.filter((e) => e.schemaVersion === 1);
    expect(v1Evs.length).toBeGreaterThanOrEqual(2);
  });

  it("gives an identical database when mixed stream is replayed twice from start", async () => {
    const { db } = await freshDb();
    await drain(mixedDeps(db));
    await db.delete(indexerCursor); // force replay over already-stored events
    await drain(mixedDeps(db));
    expect(await snapshot(db)).toEqual(mixedReference);
  });

  it("gives the same database whatever the page size for mixed stream", async () => {
    for (const size of [1, 4, 100]) {
      const { db } = await freshDb();
      await drain(mixedDeps(db, fakeRpc(mixedFixture.events), size));
      expect(await snapshot(db)).toEqual(mixedReference);
    }
  });

  it("stops on schema_version 0 and unknown schema_version 99 without advancing cursor or writing dirty events", async () => {
    for (const badVer of [0, 99]) {
      const { db } = await freshDb();
      // Corrupt event 0 schema_version to badVer
      const corrupted = mixedFixture.events.map((e, i) =>
        i === 0
          ? {
              ...e,
              valueJson: JSON.parse(
                JSON.stringify(e.valueJson).replace('{"u32":1}', `{"u32":${badVer}}`),
              ),
            }
          : e,
      );
      await expect(ingestBatch(mixedDeps(db, fakeRpc(corrupted)))).rejects.toThrow(
        UnsupportedEventError,
      );
      expect(await db.select().from(chainEvents)).toHaveLength(0);
      expect(await db.select().from(indexerCursor)).toHaveLength(0);
    }
  });

  it("stops on unknown v2 handler (e.g. unknown v99 on lock_created) and aborts batch", async () => {
    const { db } = await freshDb();
    // Corrupt event 12 (lock_created v2) schema_version to 99
    const corrupted = mixedFixture.events.map((e, i) =>
      i === 12
        ? {
            ...e,
            valueJson: JSON.parse(JSON.stringify(e.valueJson).replace('{"u32":2}', '{"u32":99}')),
          }
        : e,
    );
    // Page size 100 so all events are attempted in single transaction
    await expect(ingestBatch(mixedDeps(db, fakeRpc(corrupted), 100))).rejects.toThrow(
      UnsupportedEventError,
    );
    expect(await db.select().from(chainEvents)).toHaveLength(0);
    expect(await db.select().from(indexerCursor)).toHaveLength(0);
  });

  it("stops on missing schema_version and rolls back batch (DecodeError)", async () => {
    const { db } = await freshDb();
    const missingVer = mixedFixture.events.map((e, i) => {
      if (i !== 0) return e;
      const parsed = JSON.parse(JSON.stringify(e));
      parsed.valueJson.map = parsed.valueJson.map.filter(
        (entry: { key: { symbol?: string } }) => entry.key?.symbol !== "schema_version",
      );
      return parsed as RpcEvent;
    });
    await expect(ingestBatch(mixedDeps(db, fakeRpc(missingVer)))).rejects.toThrow(DecodeError);
    expect(await db.select().from(chainEvents)).toHaveLength(0);
    expect(await db.select().from(indexerCursor)).toHaveLength(0);
  });
});
