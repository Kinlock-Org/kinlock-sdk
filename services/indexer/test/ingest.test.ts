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

/** Run batches until a page comes back short (caught up). */
async function drain(d: IngestDeps): Promise<number> {
  let batches = 0;
  for (;;) {
    const r = await ingestBatch(d);
    batches++;
    if (r.received < (d.pageSize ?? 100)) return batches;
  }
}

const lastEvent = fixture.events[fixture.events.length - 1] as RpcEvent;

/** A Refunded event for lock 2 in the shape testnet emits (synthetic: lock 2 hasn't expired yet). */
const refundLock2: RpcEvent = {
  ...lastEvent,
  ledger: lastEvent.ledger + 100,
  id: "0021712348171468800-0000000001",
  txHash: "f".repeat(64),
  topicJson: [{ symbol: "refunded" }, { u64: "2" }],
  valueJson: {
    map: [
      { key: { symbol: "amount" }, val: { i128: "30000000" } },
      { key: { symbol: "reason" }, val: { vec: [{ symbol: "Expired" }] } },
      { key: { symbol: "schema_version" }, val: { u32: 1 } },
    ],
  },
};

/** The database after one clean replay of all fixture events, for comparisons. */
let reference: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  const { db } = await freshDb();
  await drain(deps(db));
  reference = await snapshot(db);
}, 60_000);

describe("ingest: replaying the recorded testnet events", () => {
  it("builds the expected locks, tranches and payees", async () => {
    const { db } = await freshDb();
    await drain(deps(db));

    expect(await db.select().from(chainEvents)).toHaveLength(11);

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
      state: "Open",
      endReason: null,
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

  it("records a refund as Refunded with its reason", async () => {
    const { db } = await freshDb();
    await drain(deps(db, fakeRpc([...fixture.events, refundLock2])));
    const [l2] = await db.select().from(locks).where(eq(locks.id, 2n));
    expect(l2).toMatchObject({ state: "Refunded", endReason: "Expired", returned: 30000000n });
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
    const bad = JSON.parse(JSON.stringify(refundLock2).replace('"30000000"', '"30000001"'));
    await drain(deps(db));
    await expect(ingestBatch(deps(db, fakeRpc([...fixture.events, bad])))).rejects.toThrow(
      InconsistentStateError,
    );
    const [l2] = await db.select().from(locks).where(eq(locks.id, 2n));
    expect(l2?.state).toBe("Open");
    expect(await db.select().from(chainEvents)).toHaveLength(11);
  });

  it("rolls back the whole batch when a later event in it fails", async () => {
    const { db } = await freshDb();
    const bad = JSON.parse(JSON.stringify(refundLock2).replace('"30000000"', '"30000001"'));
    const d = deps(db, fakeRpc([...fixture.events, bad]), 100);
    await expect(ingestBatch(d)).rejects.toThrow(InconsistentStateError);
    expect(await snapshot(db)).toEqual({ chainEvents: [], locks: [], tranches: [], payees: [] });
    expect(await db.select().from(indexerCursor)).toHaveLength(0);
  });
});
