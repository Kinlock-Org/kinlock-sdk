import { getEventListeners } from "node:events";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { chainEvents, indexerCursor, locks, payees, tranches } from "../src/db/schema.js";
import { InconsistentStateError, UnsupportedEventError } from "../src/handlers/types.js";
import { DecodeError } from "../src/ingest/decode.js";
import {
  GapError,
  type IngestDeps,
  ingestBatch,
  runPoller,
  sleepWithAbort,
} from "../src/ingest/poller.js";
import type { RpcClient, RpcEvent } from "../src/rpc/client.js";
import type { LockReader } from "../src/rpc/locks.js";
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

/** The real refund of lock 2 on testnet (the fixture's last event), and everything before it. */
const refundLock2 = fixture.events[fixture.events.length - 1] as RpcEvent;
const beforeRefund = fixture.events.slice(0, -1);
/** The same refund claiming one base unit more than lock 2 holds. */
const badRefund = (): RpcEvent =>
  JSON.parse(JSON.stringify(refundLock2).replace('"30000000"', '"30000001"'));

/** An ADR-0033 admin event placed after the last fixture event (same shape the contract emits). */
const upgradeEvent = (name: "upgrade_proposed" | "upgrade_applied", n: number): RpcEvent => {
  const last = fixture.events[fixture.events.length - 1] as RpcEvent;
  const fields =
    name === "upgrade_proposed"
      ? [
          { key: { symbol: "executable_at" }, val: { u64: "1797000000" } },
          { key: { symbol: "proposed_at" }, val: { u64: "1795704000" } },
        ]
      : [{ key: { symbol: "applied_at" }, val: { u64: "1797000000" } }];
  return {
    ...last,
    ledger: last.ledger + n,
    id: `9${last.id.slice(1, -10)}${String(n).padStart(10, "0")}`,
    txHash: String(n).repeat(64).slice(0, 64),
    topicJson: [{ symbol: name }, { bytes: "ab".repeat(32) }],
    valueJson: {
      map: [...fields, { key: { symbol: "schema_version" }, val: { u32: 1 } }].sort((a, b) =>
        a.key.symbol.localeCompare(b.key.symbol),
      ),
    },
  };
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

  it("records upgrade proposals and applications without touching lock or payee state", async () => {
    const { db } = await freshDb();
    await drain(deps(db, fakeRpc(fixture.events), 100));
    const before = await snapshot(db);
    const upgrades = [upgradeEvent("upgrade_proposed", 1), upgradeEvent("upgrade_applied", 2)];
    await drain(deps(db, fakeRpc([...fixture.events, ...upgrades]), 100));
    const after = await snapshot(db);
    expect(after.locks).toEqual(before.locks);
    expect(after.payees).toEqual(before.payees);
    const types = (await db.select().from(chainEvents)).map((e) => e.eventType);
    expect(types.slice(-2)).toEqual(["UpgradeProposed", "UpgradeApplied"]);
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

  it("stops on write path when amount exceeds NUMERIC(39,0) column precision", async () => {
    const { db } = await freshDb();
    const d39 = 10n ** 39n - 1n;
    const d40 = 10n ** 39n;

    // 39 digits succeeds within NUMERIC(39,0)
    await db.insert(locks).values({
      id: 999n,
      sender: "GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM",
      payeeId: KE,
      payout: "GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM",
      token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      total: d39,
      refHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      expiresAt: new Date(1800000000 * 1000),
      state: "Open",
      createdAt: new Date(),
      createdTx: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    const [inserted] = await db.select().from(locks).where(eq(locks.id, 999n));
    expect(inserted?.total).toBe(d39);

    // 40 digits fails on write path due to Postgres numeric precision
    let caught: unknown;
    try {
      await db.insert(locks).values({
        id: 1000n,
        sender: "GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM",
        payeeId: KE,
        payout: "GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM",
        token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        total: d40,
        refHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        expiresAt: new Date(1800000000 * 1000),
        state: "Open",
        createdAt: new Date(),
        createdTx: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const causeMessage = String((caught as { cause?: { message?: string } })?.cause?.message ?? "");
    expect(causeMessage).toMatch(/less than 10\^39|numeric field overflow/i);
  });

  it("ingests direct-lock LockCreated events with null or missing payee_id cleanly", async () => {
    const { db } = await freshDb();
    const baseLockEvent = fixture.events[3] as RpcEvent;

    // Direct lock 1: payee_id field missing from map
    const directLockMissingPayee: RpcEvent = {
      ...baseLockEvent,
      id: "0021711785530793984-0000000001",
      topicJson: [{ symbol: "lock_created" }, { u64: "101" }],
      valueJson: {
        map: (
          baseLockEvent.valueJson as { map: { key: { symbol: string }; val: unknown }[] }
        ).map.filter((entry) => entry.key.symbol !== "payee_id"),
      },
    };

    // Direct lock 2: payee_id is explicitly void / null
    const directLockNullPayee: RpcEvent = {
      ...baseLockEvent,
      id: "0021711785530793984-0000000002",
      topicJson: [{ symbol: "lock_created" }, { u64: "102" }],
      valueJson: {
        map: (
          baseLockEvent.valueJson as { map: { key: { symbol: string }; val: unknown }[] }
        ).map.map((entry) =>
          entry.key.symbol === "payee_id" ? { key: { symbol: "payee_id" }, val: "void" } : entry,
        ),
      },
    };

    const mockLocks: LockReader = {
      async tranches(lockId) {
        if (lockId === 101n || lockId === 102n) {
          return [
            { amount: 50000000n, unlockAt: 1791306618n },
            { amount: 50000000n, unlockAt: 1791306618n },
          ];
        }
        return fixtureLocks().tranches(lockId);
      },
    };

    await ingestBatch({
      db,
      rpc: fakeRpc([directLockMissingPayee, directLockNullPayee]),
      locks: mockLocks,
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      pageSize: 10,
    });

    const [lock101] = await db.select().from(locks).where(eq(locks.id, 101n));
    expect(lock101).toBeDefined();
    expect(lock101?.payeeId).toBeNull();
    expect(lock101?.total).toBe(100000000n);

    const [lock102] = await db.select().from(locks).where(eq(locks.id, 102n));
    expect(lock102).toBeDefined();
    expect(lock102?.payeeId).toBeNull();
    expect(lock102?.total).toBe(100000000n);
  });
});

describe("runPoller: error handling, retry backoff, and listener cleanup", () => {
  it("retries transient errors with exponential backoff and resets on successful batch", async () => {
    const { db } = await freshDb();
    const controller = new AbortController();
    let rpcAttempts = 0;
    const baseRpc = fakeRpc(fixture.events);
    const flakyRpc: RpcClient = {
      async getLatestLedger() {
        return baseRpc.getLatestLedger();
      },
      async getEvents(q) {
        rpcAttempts++;
        if (rpcAttempts === 1 || rpcAttempts === 2) {
          throw new Error(`Transient RPC error ${rpcAttempts}`);
        }
        if (rpcAttempts === 3) {
          return baseRpc.getEvents(q);
        }
        if (rpcAttempts === 4) {
          throw new Error(`Transient RPC error ${rpcAttempts}`);
        }
        return baseRpc.getEvents(q);
      },
    };

    const errors: { message: string; delay: number }[] = [];
    let successfulBatches = 0;

    await runPoller({
      db,
      rpc: flakyRpc,
      locks: fixtureLocks(),
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      pageSize: 3,
      intervalMs: 10,
      minRetryDelayMs: 10,
      maxRetryDelayMs: 50,
      signal: controller.signal,
      onError: (err, delay) => {
        errors.push({ message: (err as Error).message, delay });
      },
      onBatch: () => {
        successfulBatches++;
        if (successfulBatches === 2) {
          controller.abort();
        }
      },
    });

    expect(errors).toHaveLength(3);
    expect(errors[0]).toEqual({ message: "Transient RPC error 1", delay: 10 });
    expect(errors[1]).toEqual({ message: "Transient RPC error 2", delay: 20 });
    expect(errors[2]).toEqual({ message: "Transient RPC error 4", delay: 10 });
    expect(successfulBatches).toBe(2);
    expect(await db.select().from(chainEvents)).toHaveLength(6);
  });

  it("re-throws GapError immediately without retrying", async () => {
    const { db } = await freshDb();
    const controller = new AbortController();
    const rpc = fakeRpc(fixture.events, { oldestLedger: START_LEDGER + 1 });
    const onError = vi.fn();

    await expect(
      runPoller({
        db,
        rpc,
        locks: fixtureLocks(),
        contractId: CONTRACT_ID,
        startLedger: START_LEDGER,
        intervalMs: 10,
        signal: controller.signal,
        onError,
      }),
    ).rejects.toThrow(GapError);

    expect(onError).not.toHaveBeenCalled();
  });

  it("re-throws InconsistentStateError immediately without retrying", async () => {
    const { db } = await freshDb();
    const controller = new AbortController();
    await drain(deps(db, fakeRpc(beforeRefund)));

    const onError = vi.fn();
    await expect(
      runPoller({
        db,
        rpc: fakeRpc([...beforeRefund, badRefund()]),
        locks: fixtureLocks(),
        contractId: CONTRACT_ID,
        startLedger: START_LEDGER,
        intervalMs: 10,
        signal: controller.signal,
        onError,
      }),
    ).rejects.toThrow(InconsistentStateError);

    expect(onError).not.toHaveBeenCalled();
  });

  it("re-throws DecodeError and UnsupportedEventError immediately without retrying", async () => {
    const mystery = [{ ...fixture.events[0], topicJson: [{ symbol: "mystery" }] } as RpcEvent];
    const future = [
      JSON.parse(JSON.stringify(fixture.events[0]).replace('{"u32":1}', '{"u32":99}')) as RpcEvent,
    ];
    for (const [events, error] of [
      [mystery, DecodeError],
      [future, UnsupportedEventError],
    ] as const) {
      const { db } = await freshDb();
      const onError = vi.fn();
      await expect(
        runPoller({
          db,
          rpc: fakeRpc(events),
          locks: fixtureLocks(),
          contractId: CONTRACT_ID,
          startLedger: START_LEDGER,
          intervalMs: 10,
          signal: new AbortController().signal,
          onError,
        }),
      ).rejects.toThrow(error);
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it("does not leak abort listeners across multiple sleep cycles", async () => {
    const controller = new AbortController();
    for (let i = 0; i < 15; i++) {
      await sleepWithAbort(5, controller.signal);
      expect(getEventListeners(controller.signal, "abort").length).toBe(0);
    }

    controller.abort();
    await sleepWithAbort(100, controller.signal);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("does not leak abort listeners across multiple poller cycles", async () => {
    const { db } = await freshDb();
    const controller = new AbortController();
    const emptyRpc = fakeRpc([], { latestLedger: START_LEDGER + 10 });
    let cycles = 0;

    await runPoller({
      db,
      rpc: emptyRpc,
      locks: fixtureLocks(),
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      intervalMs: 5,
      signal: controller.signal,
      onBatch: () => {
        cycles++;
        if (cycles >= 5) {
          controller.abort();
        }
      },
    });

    expect(cycles).toBeGreaterThanOrEqual(5);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });
});
