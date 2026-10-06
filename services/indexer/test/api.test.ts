import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import type { Db } from "../src/db/client.js";
import { payees } from "../src/db/schema.js";
import { ingestBatch } from "../src/ingest/poller.js";
import {
  CONTRACT_ID,
  fakeRpc,
  fixture,
  fixtureLocks,
  freshDb,
  START_LEDGER,
} from "./helpers/fixtures.js";

const KE = "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba";
const PH = "a7815d079f7663968e7ce11c3765009a09c5daccb4a123a9102d3f7567d43866";
const SENDER = "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3";

let db: Db;
let indexedLedger: number;

function app(tip: () => Promise<number> = async () => indexedLedger + 3) {
  return buildServer({ db, latestLedger: tip, maxLagLedgers: 10 }, { logger: false });
}

async function get(path: string, tip?: () => Promise<number>) {
  const res = await app(tip).inject({ method: "GET", url: path });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  ({ db } = await freshDb());
  const r = await ingestBatch({
    db,
    rpc: fakeRpc(fixture.events),
    locks: fixtureLocks(),
    contractId: CONTRACT_ID,
    startLedger: START_LEDGER,
  });
  indexedLedger = r.lastLedger;
  // Registry fields arrive with the registry join (M2-13); set two by hand for filter tests.
  await db
    .update(payees)
    .set({ slug: "ke-kinlock-test-school", displayName: "Kinlock Test School", country: "KE" })
    .where(eq(payees.payeeId, KE));
  await db
    .update(payees)
    .set({ slug: "ph-kinlock-test-rentals", displayName: "Kinlock Test Rentals", country: "PH" })
    .where(eq(payees.payeeId, PH));
}, 60_000);

describe("GET /locks", () => {
  it("lists newest first, labeled as indexer data, amounts as strings", async () => {
    const { status, body } = await get("/locks");
    expect(status).toBe(200);
    expect(body.source).toBe("indexer");
    expect(body.indexedLedger).toBe(indexedLedger);
    expect(body.locks.map((l: { id: string }) => l.id)).toEqual(["2", "1"]);
    expect(body.locks[1]).toMatchObject({
      total: "100000000",
      released: "50000000",
      returned: "50000000",
      state: "Declined",
      endReason: "Declined",
    });
    expect(body.next).toBeNull();
  });

  it("filters by sender, payee and state", async () => {
    expect((await get(`/locks?sender=${SENDER}`)).body.locks).toHaveLength(2);
    expect(
      (await get(`/locks?payee_id=${PH}`)).body.locks.map((l: { id: string }) => l.id),
    ).toEqual(["2"]);
    expect(
      (await get("/locks?state=Declined")).body.locks.map((l: { id: string }) => l.id),
    ).toEqual(["1"]);
    expect((await get("/locks?state=Completed")).body.locks).toEqual([]);
  });

  it("pages with limit and before", async () => {
    const first = await get("/locks?limit=1");
    expect(first.body.locks.map((l: { id: string }) => l.id)).toEqual(["2"]);
    expect(first.body.next).toBe("2");
    const second = await get(`/locks?limit=1&before=${first.body.next}`);
    expect(second.body.locks.map((l: { id: string }) => l.id)).toEqual(["1"]);
    expect(second.body.next).toBeNull();
  });

  it("rejects bad filters with 400", async () => {
    for (const q of [
      "sender=GABC",
      "payee_id=xyz",
      "state=Lost",
      "limit=0",
      "limit=101",
      "before=-1",
    ]) {
      const { status, body } = await get(`/locks?${q}`);
      expect(status, q).toBe(400);
      expect(body.error).toBe("bad_request");
    }
  });
});

describe("GET /locks/:id", () => {
  it("returns the lock with its tranches", async () => {
    const { status, body } = await get("/locks/1");
    expect(status).toBe(200);
    expect(body.source).toBe("indexer");
    expect(body.lock.tranches).toEqual([
      expect.objectContaining({ idx: 0, amount: "50000000", released: true }),
      expect.objectContaining({ idx: 1, amount: "50000000", released: false, releaseTx: null }),
    ]);
    expect(body.lock.tranches[0].unlockAt).toBe(new Date(1791299418 * 1000).toISOString());
  });

  it("404s an unknown lock and 400s a bad id", async () => {
    expect((await get("/locks/99")).status).toBe(404);
    expect((await get("/locks/abc")).status).toBe(400);
    expect((await get("/locks/18446744073709551616")).status).toBe(400); // 2^64
  });
});

describe("GET /payees", () => {
  it("lists every payee, with registry fields null until joined", async () => {
    const { body } = await get("/payees");
    expect(body.source).toBe("indexer");
    expect(body.payees).toHaveLength(3);
    const unjoined = body.payees.find((p: { country: string | null }) => p.country === null);
    expect(unjoined).toMatchObject({ slug: null, displayName: null, status: "Active" });
  });

  it("filters by category, country and text", async () => {
    const ids = async (q: string) =>
      (await get(`/payees?${q}`)).body.payees.map((p: { payeeId: string }) => p.payeeId);
    expect(await ids("category=Rent")).toEqual([PH]);
    expect(await ids("country=KE")).toEqual([KE]);
    expect(await ids("q=rentals")).toEqual([PH]);
    expect(await ids("q=kinlock%20test")).toHaveLength(2);
    expect(await ids("q=%25")).toEqual([]); // % is a literal, not a wildcard
  });

  it("pages with limit and after", async () => {
    const first = await get("/payees?limit=2");
    expect(first.body.payees).toHaveLength(2);
    const second = await get(`/payees?limit=2&after=${first.body.next}`);
    expect(second.body.payees).toHaveLength(1);
    expect(second.body.next).toBeNull();
  });

  it("rejects bad filters with 400", async () => {
    for (const q of ["country=ke", "country=KEN", "category=Health", "after=zz"]) {
      expect((await get(`/payees?${q}`)).status, q).toBe(400);
    }
  });
});

describe("GET /health", () => {
  it("is ok within the lag limit", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      indexedLedger,
      latestLedger: indexedLedger + 3,
      lagLedgers: 3,
    });
    expect(body.lastBatchAt).not.toBeNull();
  });

  it("is lagging (503) beyond the limit", async () => {
    const { status, body } = await get("/health", async () => indexedLedger + 11);
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "lagging", lagLedgers: 11 });
  });

  it("is unknown (503) when the chain tip can't be read", async () => {
    const { status, body } = await get("/health", async () => {
      throw new Error("rpc down");
    });
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "unknown", latestLedger: null, indexedLedger });
  });
});
