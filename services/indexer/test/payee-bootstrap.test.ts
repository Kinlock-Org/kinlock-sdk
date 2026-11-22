/**
 * Seeding payee rows from chain when the event history cannot supply them. Roadmap M2-28.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { payees } from "../src/db/schema.js";
import { bootstrapPayees } from "../src/registry/bootstrap.js";
import { canonicalize, syncRegistry } from "../src/registry/sync.js";
import type { ChainPayee } from "../src/rpc/payees.js";
import { fakePayees, freshDb, REGISTRY_FIXTURES, snapshot } from "./helpers/fixtures.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const idOf = (slug: string) => sha(slug);

const KE = "ke-kinlock-test-school";
const NG = "ng-kinlock-test-academy";
const PH = "ph-kinlock-test-rentals";
const ATTESTER = "GCZRNEOGZH7FVJTA4OQN2YQ5LMS7LSV2GP7PWJFC73SMSLPA56DRAPQT";
const REGISTERED_AT = 1791285287n;

/** What the contract reports for a registry payee whose file has not been touched since. */
function chainState(slug: string, over: Partial<ChainPayee> = {}): ChainPayee {
  const file = join(REGISTRY_FIXTURES, "payees", slug.slice(0, 2), `${slug}.json`);
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return {
    payout: json.payout_address as string,
    attester: ATTESTER,
    category: json.category as ChainPayee["category"],
    status: "Active",
    metaHash: sha(canonicalize(json)),
    registeredAt: REGISTERED_AT,
    statusChangedAt: REGISTERED_AT,
    ...over,
  };
}

const ke = chainState(KE);
const ng = chainState(NG);
const ph = chainState(PH);
const ALL = { [idOf(KE)]: ke, [idOf(NG)]: ng, [idOf(PH)]: ph };
const IDS = [idOf(KE), idOf(NG), idOf(PH)].sort();

/** A writable copy of the registry fixtures. */
function registryCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "kinlock-registry-"));
  cpSync(REGISTRY_FIXTURES, dir, { recursive: true });
  return dir;
}

let db: Db;

beforeEach(async () => {
  ({ db } = await freshDb());
});

const row = async (payeeId: string) =>
  (await db.select().from(payees).where(eq(payees.payeeId, payeeId)))[0];

describe("payee bootstrap", () => {
  it("seeds every registry payee that has no row, with the values the contract reports", async () => {
    const reader = fakePayees(ALL);
    expect(await bootstrapPayees(db, REGISTRY_FIXTURES, reader)).toEqual({
      seeded: IDS,
      skipped: [],
    });
    expect(reader.reads).toEqual(IDS);
    expect(await row(idOf(KE))).toEqual({
      payeeId: idOf(KE),
      slug: null,
      category: "School",
      status: "Active",
      statusChangedAt: new Date(Number(REGISTERED_AT) * 1000),
      payout: "GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM",
      payoutUpdatedAt: null,
      attester: ATTESTER,
      metaHash: ke.metaHash,
      displayName: null,
      country: null,
      localCurrency: null,
      city: null,
      attesterHandle: null,
      registeredAt: new Date(Number(REGISTERED_AT) * 1000),
    });
  });

  it("writes the status the chain reports, not an assumed Active one", async () => {
    const reader = fakePayees({ ...ALL, [idOf(NG)]: chainState(NG, { status: "Suspended" }) });
    await bootstrapPayees(db, REGISTRY_FIXTURES, reader);
    expect(await row(idOf(NG))).toMatchObject({ status: "Suspended" });
  });

  it("leaves a row the event pipeline already wrote alone", async () => {
    await db.insert(payees).values({
      payeeId: idOf(KE),
      category: "School",
      status: "Revoked",
      statusChangedAt: new Date(1),
      payout: ke.payout,
      attester: ke.attester,
      metaHash: ke.metaHash,
      registeredAt: new Date(1),
    });
    const reader = fakePayees(ALL);
    const r = await bootstrapPayees(db, REGISTRY_FIXTURES, reader);
    expect(r.seeded).toEqual([idOf(NG), idOf(PH)].sort());
    expect(reader.reads).toEqual([idOf(NG), idOf(PH)].sort());
    expect(await row(idOf(KE))).toMatchObject({ status: "Revoked", registeredAt: new Date(1) });
  });

  it("reports a registry payee this contract never registered", async () => {
    const reader = fakePayees({ ...ALL, [idOf(PH)]: undefined });
    const r = await bootstrapPayees(db, REGISTRY_FIXTURES, reader);
    expect(r.seeded).toEqual([idOf(KE), idOf(NG)].sort());
    expect(r.skipped).toEqual([{ payeeId: idOf(PH), reason: "not registered on this contract" }]);
    expect(await row(idOf(PH))).toBeUndefined();
  });

  it("keeps seeding when one payee cannot be read, and says why", async () => {
    const reader = fakePayees({
      ...ALL,
      [idOf(NG)]: new Error("get_payee(…): state is archived"),
    });
    const r = await bootstrapPayees(db, REGISTRY_FIXTURES, reader);
    expect(r.seeded).toEqual([idOf(KE), idOf(PH)].sort());
    expect(r.skipped).toEqual([{ payeeId: idOf(NG), reason: "get_payee(…): state is archived" }]);
  });

  it("joins display data onto a bootstrapped row, as it does onto an event-derived one", async () => {
    await bootstrapPayees(db, REGISTRY_FIXTURES, fakePayees(ALL));
    expect(await syncRegistry(db, REGISTRY_FIXTURES)).toEqual({
      joined: 3,
      unmatched: [],
      invalidFiles: [],
    });
    expect(await row(idOf(PH))).toMatchObject({
      slug: PH,
      displayName: "Kinlock Test Rentals (fixture)",
      country: "PH",
      localCurrency: "PHP",
      city: "Quezon City",
      attesterHandle: "kinlock-testnet-attester-1",
    });
  });

  it("shows nothing for a bootstrapped payee whose file was edited after registration", async () => {
    const dir = registryCopy();
    const file = join(dir, "payees", "ke", `${KE}.json`);
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...json, city: "Elsewhere" }, null, 2));
    await bootstrapPayees(db, dir, fakePayees(ALL));
    const sync = await syncRegistry(db, dir);
    expect(sync.unmatched).toEqual([idOf(KE)]);
    expect(sync.joined).toBe(2);
    expect(await row(idOf(KE))).toMatchObject({ slug: null, city: null, displayName: null });
  });

  it("is idempotent: a second run reads nothing and changes nothing", async () => {
    await bootstrapPayees(db, REGISTRY_FIXTURES, fakePayees(ALL));
    const before = (await snapshot(db)).payees;
    const second = fakePayees(ALL);
    expect(await bootstrapPayees(db, REGISTRY_FIXTURES, second)).toEqual({
      seeded: [],
      skipped: [],
    });
    expect(second.reads).toEqual([]);
    expect((await snapshot(db)).payees).toEqual(before);
  });
});
