import { nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { Err, Ok } from "@stellar/stellar-sdk/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getLockRaw = vi.fn();
vi.mock("@kinlock/contract", () => ({
  // A class, so `new Client()` works (an arrow function can't be constructed).
  Client: class {
    get_lock = getLockRaw;
  },
}));

const { verifyReceipt } = await import("../receipts.js");

const CONTRACT = "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI";
const PAYOUT = "GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM";
const TX = "d6".repeat(32);
const config = {
  rpcUrl: "https://rpc.example",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: CONTRACT,
  indexerUrl: "https://indexer.example",
};

const map = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })),
  );
const released = (overrides: Record<string, xdr.ScVal> = {}) =>
  map({
    amount: nativeToScVal(5_000_000n, { type: "i128" }),
    idx: nativeToScVal(0, { type: "u32" }),
    payout: nativeToScVal(PAYOUT, { type: "address" }),
    schema_version: nativeToScVal(1, { type: "u32" }),
    ...overrides,
  });

/** One RPC event as stellar-sdk returns it. */
const rpcEvent = (name: string, value: xdr.ScVal, index = 1, ok = true) => ({
  id: `0021711794120744960-000000000${index}`,
  txHash: TX,
  ledger: 100,
  ledgerClosedAt: "2026-10-07T08:29:17Z",
  inSuccessfulContractCall: ok,
  topic: [xdr.ScVal.scvSymbol(name), nativeToScVal(3n, { type: "u64" })],
  value,
});

let tx: { status: string; ledger?: number };
let events: ReturnType<typeof rpcEvent>[];
let indexed: { status: number; body?: unknown };

const rawLock = (over: Record<string, unknown> = {}) => ({
  id: 3n,
  sender: "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3",
  payee_id: new Uint8Array(32),
  payout: PAYOUT,
  token: CONTRACT,
  total: 10_000_000n,
  released: 5_000_000n,
  returned: 5_000_000n,
  ref_hash: new Uint8Array(32),
  tranches: [
    { amount: 5_000_000n, unlock_at: 1n, released: true },
    { amount: 5_000_000n, unlock_at: 1n, released: false },
  ],
  expires_at: 2n,
  state: { tag: "Declined" },
  created_at: 1n,
  ...over,
});

beforeEach(() => {
  tx = { status: "SUCCESS", ledger: 100 };
  events = [rpcEvent("transfer", map({}), 0), rpcEvent("released", released())];
  indexed = { status: 404 };
  vi.spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(
    async () => tx as unknown as rpc.Api.GetTransactionResponse,
  );
  vi.spyOn(rpc.Server.prototype, "getEvents").mockImplementation(
    async () => ({ events }) as unknown as rpc.Api.GetEventsResponse,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(indexed.body ?? {}), { status: indexed.status })),
  );
  getLockRaw.mockResolvedValue({ result: new Ok(rawLock()) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("verifyReceipt, tier 1 (live RPC)", () => {
  it("verifies a Released event and returns details from the event", async () => {
    const r = await verifyReceipt(config, { txHash: TX, eventIndex: 1 });
    expect(r).toEqual({
      valid: true,
      tier: "live_rpc",
      kind: "Released",
      reason: "verified",
      receipt: {
        lockId: 3n,
        amount: 5_000_000n,
        trancheIndex: 0,
        payout: PAYOUT,
        ledgerTime: "2026-10-07T08:29:17.000Z",
      },
    });
  });

  it("verifies Refunded (with its reason) and Declined events", async () => {
    events = [
      rpcEvent(
        "refunded",
        map({
          amount: nativeToScVal(30_000_000n, { type: "i128" }),
          reason: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Expired")]),
          schema_version: nativeToScVal(1, { type: "u32" }),
        }),
      ),
    ];
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).receipt).toMatchObject({
      amount: 30_000_000n,
      refundReason: "Expired",
    });
    events = [
      rpcEvent(
        "declined",
        map({
          amount: nativeToScVal(5_000_000n, { type: "i128" }),
          schema_version: nativeToScVal(1, { type: "u32" }),
        }),
      ),
    ];
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).kind).toBe("Declined");
  });

  it("rejects tampered references: another event in the tx, a missing index, a non-receipt event", async () => {
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 0 })).reason).toBe("not_found");
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 4 })).reason).toBe("not_found");
    events = [rpcEvent("lock_created", released())];
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).valid).toBe(false);
  });

  it("rejects an event from a failed call, an unknown schema version, or a failed transaction", async () => {
    events = [rpcEvent("released", released(), 1, false)];
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).valid).toBe(false);
    events = [
      rpcEvent("released", released({ schema_version: nativeToScVal(2, { type: "u32" }) })),
    ];
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).valid).toBe(false);
    tx = { status: "FAILED" };
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).reason).toBe("not_found");
  });
});

describe("verifyReceipt, tier 2 (lock state)", () => {
  const releasedRow = {
    event: {
      type: "Released",
      txHash: TX,
      eventIndex: 1,
      payload: { key: "3", amount: "5000000", idx: 0 },
    },
  };

  beforeEach(() => {
    tx = { status: "NOT_FOUND" }; // older than RPC retention
  });

  it("confirms a release on chain via the indexer's lookup", async () => {
    indexed = { status: 200, body: releasedRow };
    expect(await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).toEqual({
      valid: true,
      tier: "lock_state",
      kind: "Released",
      reason: "verified",
      receipt: { lockId: 3n, amount: 5_000_000n, trancheIndex: 0, payout: PAYOUT },
    });
  });

  it("reports a mismatch when the chain contradicts the indexer", async () => {
    indexed = {
      status: 200,
      body: { event: { ...releasedRow.event, payload: { key: "3", amount: "5000000", idx: 1 } } },
    };
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).reason).toBe("mismatch");
    indexed = {
      status: 200,
      body: { event: { ...releasedRow.event, payload: { key: "3", amount: "4000000", idx: 0 } } },
    };
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).reason).toBe("mismatch");
  });

  it("confirms a decline from the lock's state and returned amount", async () => {
    indexed = {
      status: 200,
      body: {
        event: {
          type: "Declined",
          txHash: TX,
          eventIndex: 1,
          payload: { key: "3", amount: "5000000" },
        },
      },
    };
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).valid).toBe(true);
    getLockRaw.mockResolvedValue({ result: new Ok(rawLock({ state: { tag: "Open" } })) });
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).reason).toBe("mismatch");
  });

  it("is not_found when the indexer has no such event", async () => {
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).reason).toBe("not_found");
  });

  it("is unverifiable (never valid) without an indexer, with the indexer down, or once the lock entry is gone", async () => {
    const { indexerUrl: _, ...noIndexer } = config;
    expect((await verifyReceipt(noIndexer, { txHash: TX, eventIndex: 1 })).reason).toBe(
      "unverifiable",
    );
    indexed = { status: 503 };
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).reason).toBe(
      "unverifiable",
    );
    indexed = { status: 200, body: releasedRow };
    getLockRaw.mockResolvedValue({
      result: new Err({ message: "LockNotFound: no lock exists with this ID." }),
    });
    const gone = await verifyReceipt(config, { txHash: TX, eventIndex: 1 });
    expect(gone).toMatchObject({ valid: false, reason: "unverifiable" });
  });
});

describe("verifyReceipt input and failures", () => {
  it("rejects a malformed reference", async () => {
    await expect(verifyReceipt(config, { txHash: "xyz", eventIndex: 1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(verifyReceipt(config, { txHash: TX, eventIndex: -1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("is unverifiable, not an exception, when RPC is down", async () => {
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockRejectedValue(new Error("rpc down"));
    expect((await verifyReceipt(config, { txHash: TX, eventIndex: 1 })).reason).toBe(
      "unverifiable",
    );
  });
});
