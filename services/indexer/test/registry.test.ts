import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { payees } from "../src/db/schema.js";
import { ingestBatch } from "../src/ingest/poller.js";
import { canonicalize, syncRegistry } from "../src/registry/sync.js";
import {
  CONTRACT_ID,
  fakeRpc,
  fixture,
  fixtureLocks,
  freshDb,
  REGISTRY_FIXTURES,
  START_LEDGER,
} from "./helpers/fixtures.js";

const KE = "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba";
const NG = "3e7236118c83eb3bd37927155be21cc90ada773aaca86380d28cea5f712be2f1";
const PH = "a7815d079f7663968e7ce11c3765009a09c5daccb4a123a9102d3f7567d43866";
const KE_FILE = "payees/ke/ke-kinlock-test-school.json";

let db: Db;

beforeEach(async () => {
  ({ db } = await freshDb());
  await ingestBatch({
    db,
    rpc: fakeRpc(fixture.events),
    locks: fixtureLocks(),
    contractId: CONTRACT_ID,
    startLedger: START_LEDGER,
  });
}, 60_000);

/** A writable copy of the registry fixtures. */
function registryCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "kinlock-registry-"));
  cpSync(REGISTRY_FIXTURES, dir, { recursive: true });
  return dir;
}

function edit(dir: string, file: string, change: (j: Record<string, unknown>) => void) {
  const path = join(dir, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  change(json);
  writeFileSync(path, JSON.stringify(json, null, 2));
}

const payee = async (id: string) =>
  (await db.select().from(payees).where(eq(payees.payeeId, id)))[0];

describe("registry join", () => {
  it("joins every payee whose file matches the on-chain meta_hash", async () => {
    const r = await syncRegistry(db, REGISTRY_FIXTURES);
    expect(r).toEqual({ joined: 3, unmatched: [], invalidFiles: [] });
    expect(await payee(KE)).toMatchObject({
      slug: "ke-kinlock-test-school",
      displayName: "Kinlock Test School (fixture)",
      country: "KE",
      localCurrency: "KES",
      city: "Nairobi",
      attesterHandle: "kinlock-testnet-attester-1",
    });
    expect((await payee(NG))?.country).toBe("NG");
    expect((await payee(PH))?.country).toBe("PH");
  });

  it("hashes like the registry repo (key order and spacing don't matter)", () => {
    expect(canonicalize({ b: 1, a: [{ d: "é", c: null }] })).toBe(
      '{"a":[{"c":null,"d":"é"}],"b":1}',
    );
  });

  it("shows nothing from a file edited after registration", async () => {
    const dir = registryCopy();
    edit(dir, KE_FILE, (j) => {
      j.display_name = "Someone Else's School";
    });
    const r = await syncRegistry(db, dir);
    expect(r.unmatched).toEqual([KE]);
    expect(await payee(KE)).toMatchObject({
      slug: null,
      displayName: null,
      country: null,
      city: null,
    });
    expect((await payee(PH))?.displayName).toBe("Kinlock Test Rentals (fixture)");
  });

  it("clears fields that were joined before once the file stops matching", async () => {
    await syncRegistry(db, REGISTRY_FIXTURES);
    const dir = registryCopy();
    edit(dir, KE_FILE, (j) => {
      j.city = "Elsewhere";
    });
    await syncRegistry(db, dir);
    expect((await payee(KE))?.city).toBeNull();
    await syncRegistry(db, REGISTRY_FIXTURES);
    expect((await payee(KE))?.city).toBe("Nairobi");
  });

  it("hides the attester handle when its file names a different address", async () => {
    const dir = registryCopy();
    edit(dir, "attesters/kinlock-testnet-attester-1.json", (j) => {
      j.address = "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3";
    });
    await syncRegistry(db, dir);
    expect(await payee(KE)).toMatchObject({
      displayName: "Kinlock Test School (fixture)",
      attesterHandle: null,
    });
  });

  it("reports malformed files and leaves their payee unjoined", async () => {
    const dir = registryCopy();
    writeFileSync(join(dir, KE_FILE), "{ not json");
    const r = await syncRegistry(db, dir);
    expect(r.invalidFiles).toEqual([join(dir, KE_FILE)]);
    expect(r.unmatched).toEqual([KE]);
  });

  it("doesn't fail when the registry folder is missing", async () => {
    const r = await syncRegistry(db, join(tmpdir(), "no-such-registry"));
    expect(r.joined).toBe(0);
    expect(r.unmatched).toHaveLength(3);
  });
});
