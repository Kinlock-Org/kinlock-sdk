import { beforeAll, describe, expect, it } from "vitest";
import { parseBackfillArgs, runBackfill } from "../src/cli/backfill.js";
import { chainEvents } from "../src/db/schema.js";
import {
  CONTRACT_ID,
  fakeRpc,
  fixture,
  fixtureLocks,
  freshDb,
  START_LEDGER,
  snapshot,
} from "./helpers/fixtures.js";

let reference: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  const { db } = await freshDb();
  await runBackfill({
    db,
    rpc: fakeRpc(fixture.events),
    locks: fixtureLocks(),
    contractId: CONTRACT_ID,
    startLedger: START_LEDGER,
    batchSize: 100,
  });
  reference = await snapshot(db);
}, 60_000);

describe("backfill CLI argument parser", () => {
  it("parses --start-ledger and --batch-size in both space and equals forms", () => {
    expect(parseBackfillArgs([])).toEqual({});
    expect(parseBackfillArgs(["--start-ledger", "501200", "--batch-size", "25"])).toEqual({
      startLedger: 501200,
      batchSize: 25,
    });
    expect(parseBackfillArgs(["--start-ledger=600000", "--batch-size=50"])).toEqual({
      startLedger: 600000,
      batchSize: 50,
    });
  });

  it("rejects unknown or non-positive arguments", () => {
    expect(() => parseBackfillArgs(["--start-ledger", "0"])).toThrow(/positive integer/);
    expect(() => parseBackfillArgs(["--batch-size", "abc"])).toThrow(/positive integer/);
    expect(() => parseBackfillArgs(["--unknown"])).toThrow(/Unknown argument/);
  });
});

describe("runBackfill: PGlite replay from deployment block", () => {
  it("reconstructs full database state from chain events across batches", async () => {
    const { db } = await freshDb();
    const summary = await runBackfill({
      db,
      rpc: fakeRpc(fixture.events),
      locks: fixtureLocks(),
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      batchSize: 3,
    });

    expect(summary.batches).toBe(5);
    expect(summary.received).toBe(12);
    expect(summary.stored).toBe(12);
    expect(await db.select().from(chainEvents)).toHaveLength(12);
    expect(await snapshot(db)).toEqual(reference);
  });

  it("replays from startLedger without duplicating rows when run on an existing database", async () => {
    const { db } = await freshDb();
    const first = await runBackfill({
      db,
      rpc: fakeRpc(fixture.events),
      locks: fixtureLocks(),
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      batchSize: 4,
    });
    expect(first.stored).toBe(12);

    const second = await runBackfill({
      db,
      rpc: fakeRpc(fixture.events),
      locks: fixtureLocks(),
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      batchSize: 2,
    });
    expect(second.received).toBe(12);
    expect(second.stored).toBe(0);
    expect(await db.select().from(chainEvents)).toHaveLength(12);
    expect(await snapshot(db)).toEqual(reference);
  });
});
