import { Asset, Contract, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { Err, Ok } from "@stellar/stellar-sdk/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPayee = vi.fn();
vi.mock("@kinlock/contract", () => ({
  // A class, so `new Client()` works (an arrow function can't be constructed).
  Client: class {
    get_payee = getPayee;
  },
}));

const { preflight } = await import("../preflight.js");

const SENDER = "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3";
const PAYOUT = "GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM";
const OTHER = "GDPUY733T3UNZWG4EQMEBHBDGKD33YSFPOI2RB4AIK2JMOENKEXWK7ZG";
const C_PAYOUT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PAYEE = "44".repeat(32);
const REF = "de".repeat(32);
const NOW = 1_800_000_000n;
const DAY = 86_400;

const config = {
  rpcUrl: "https://rpc.example",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
  indexerUrl: "https://indexer.example",
};
const params = { sender: SENDER, token: TOKEN, payeeId: PAYEE, total: 10_000_000n, refHash: REF };

/** World state the mocks answer from; each test changes what it needs. */
let world: {
  balance: bigint;
  payee: { payout: string; status: string } | "missing";
  trustline: { flags: number; limit: bigint; balance: bigint } | null;
  indexerPayees: { payeeId: string; payout: string; payoutUpdatedAt: string | null }[];
  indexerLocks: { id: string; payeeId: string; refHash: string }[];
  indexerDown: boolean;
};

const iso = (secondsAgo: number) => new Date((Number(NOW) - secondsAgo) * 1000).toISOString();

beforeEach(() => {
  world = {
    balance: 50_000_000n,
    payee: { payout: PAYOUT, status: "Active" },
    trustline: { flags: 1, limit: 9_223_372_036_854_775_807n, balance: 0n },
    indexerPayees: [{ payeeId: PAYEE, payout: PAYOUT, payoutUpdatedAt: null }],
    indexerLocks: [],
    indexerDown: false,
  };
  getPayee.mockImplementation(async () => ({
    result:
      world.payee === "missing"
        ? new Err({ message: "PayeeNotFound: no payee with this ID." })
        : new Ok({ payout: world.payee.payout, status: { tag: world.payee.status } }),
  }));
  // read() builds the call and starts the simulation synchronously, so the last method built
  // is the one being simulated.
  let lastMethod = "";
  const call = Contract.prototype.call;
  vi.spyOn(Contract.prototype, "call").mockImplementation(function (
    this: Contract,
    method,
    ...args
  ) {
    lastMethod = method;
    return call.call(this, method, ...args);
  });
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(
    async () =>
      ({
        transactionData: {},
        result: {
          retval:
            lastMethod === "balance"
              ? nativeToScVal(world.balance, { type: "i128" })
              : nativeToScVal(`USDC:${ISSUER}`),
        },
      }) as unknown as rpc.Api.SimulateTransactionResponse,
  );
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation(
    async () =>
      ({
        latestLedger: 1,
        entries: world.trustline ? [{ val: { type: "trustline", value: world.trustline } }] : [],
      }) as unknown as rpc.Api.GetLedgerEntriesResponse,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      if (world.indexerDown) return new Response("down", { status: 503 });
      const body =
        url.pathname === "/payees"
          ? { payees: world.indexerPayees }
          : { locks: world.indexerLocks };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const run = async (overrides = {}, cfg = config) => {
  const results = await preflight(cfg, { ...params, ...overrides }, NOW);
  return Object.fromEntries(results.map((r) => [r.check, r]));
};

describe("preflight", () => {
  it("passes every check for a healthy payee, in a fixed order with severities", async () => {
    const results = await preflight(config, params, NOW);
    expect(results.map((r) => [r.check, r.status, r.severity])).toEqual([
      ["sender_balance", "pass", "block"],
      ["payee_active", "pass", "block"],
      ["recent_payout_change", "pass", "warn"],
      ["duplicate_ref_hash", "pass", "warn"],
      ["payout_trustline_authorized", "pass", "block"],
    ]);
    expect(results[0]?.messageKey).toBe("preflight.sender_balance.pass");
  });

  it("fails the balance check when the sender has less than the total", async () => {
    world.balance = 9_999_999n;
    expect((await run()).sender_balance?.status).toBe("fail");
  });

  it("fails payee_active for a suspended or unknown payee; dependent checks become unknown", async () => {
    world.payee = { payout: PAYOUT, status: "Suspended" };
    expect((await run()).payee_active).toMatchObject({
      status: "fail",
      messageKey: "preflight.payee_active.suspended",
    });
    world.payee = "missing";
    const r = await run();
    expect(r.payee_active).toMatchObject({
      status: "fail",
      messageKey: "preflight.payee_active.not_found",
    });
    expect(r.payout_trustline_authorized).toMatchObject({
      status: "unknown",
      messageKey: "preflight.payout_trustline_authorized.no_payee",
    });
    expect(r.recent_payout_change?.status).toBe("unknown");
  });

  it("checks the payout trustline: missing, not authorized, no room, contract account", async () => {
    world.trustline = null;
    expect((await run()).payout_trustline_authorized?.messageKey).toBe(
      "preflight.payout_trustline_authorized.missing",
    );
    world.trustline = { flags: 0, limit: 10n ** 18n, balance: 0n };
    expect((await run()).payout_trustline_authorized?.messageKey).toBe(
      "preflight.payout_trustline_authorized.not_authorized",
    );
    world.trustline = { flags: 1, limit: 15_000_000n, balance: 10_000_000n };
    expect((await run()).payout_trustline_authorized).toMatchObject({
      status: "fail",
      messageKey: "preflight.payout_trustline_authorized.limit",
    });
    world.payee = { payout: C_PAYOUT, status: "Active" };
    expect((await run()).payout_trustline_authorized?.messageKey).toBe(
      "preflight.payout_trustline_authorized.contract_account",
    );
  });

  it("handles real xdr.LedgerEntryData.trustline instances: pass, fail (not_authorized), fail (limit)", async () => {
    const makeEntry = (flags: number, limit: bigint, balance: bigint) => {
      const accountId = Keypair.fromPublicKey(PAYOUT).xdrAccountId();
      const asset = new Asset("USDC", ISSUER).toTrustLineXdrObject();
      const tl = new xdr.TrustLineEntry({
        accountId,
        asset,
        balance,
        limit,
        flags,
        ext: xdr.TrustLineEntryExt.v0(),
      });
      return xdr.LedgerEntryData.trustline(tl);
    };

    // Pass: authorized with sufficient room (limit 100m, balance 10m, total 10m -> room 90m >= 10m)
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockResolvedValueOnce({
      latestLedger: 1,
      entries: [
        {
          key: {} as unknown as xdr.LedgerKey,
          val: makeEntry(1, 100_000_000n, 10_000_000n),
        } as unknown as rpc.Api.LedgerEntryResult,
      ],
    });
    let r = await run();
    expect(r.payout_trustline_authorized).toMatchObject({
      status: "pass",
      messageKey: "preflight.payout_trustline_authorized.pass",
    });

    // Fail: not authorized (flags = 0)
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockResolvedValueOnce({
      latestLedger: 1,
      entries: [
        {
          key: {} as unknown as xdr.LedgerKey,
          val: makeEntry(0, 100_000_000n, 0n),
        } as unknown as rpc.Api.LedgerEntryResult,
      ],
    });
    r = await run();
    expect(r.payout_trustline_authorized).toMatchObject({
      status: "fail",
      messageKey: "preflight.payout_trustline_authorized.not_authorized",
    });

    // Fail: limit room insufficient (room = 15m - 10m = 5m < 10m total)
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockResolvedValueOnce({
      latestLedger: 1,
      entries: [
        {
          key: {} as unknown as xdr.LedgerKey,
          val: makeEntry(1, 15_000_000n, 10_000_000n),
        } as unknown as rpc.Api.LedgerEntryResult,
      ],
    });
    r = await run();
    expect(r.payout_trustline_authorized).toMatchObject({
      status: "fail",
      messageKey: "preflight.payout_trustline_authorized.limit",
    });

    // Function accessors compatibility (.trustLine(), .flags(), .limit(), .balance())
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockResolvedValueOnce({
      latestLedger: 1,
      entries: [
        {
          key: {} as unknown as xdr.LedgerKey,
          val: {
            type: "trustline",
            trustLine: () => ({
              flags: () => 1,
              limit: () => 100_000_000n,
              balance: () => 0n,
            }),
          },
        } as unknown as rpc.Api.LedgerEntryResult,
      ],
    });
    r = await run();
    expect(r.payout_trustline_authorized).toMatchObject({
      status: "pass",
      messageKey: "preflight.payout_trustline_authorized.pass",
    });
  });

  it("warns on a payout change in the last 7 days, or one the indexer hasn't seen yet", async () => {
    world.indexerPayees = [{ payeeId: PAYEE, payout: PAYOUT, payoutUpdatedAt: iso(2 * DAY) }];
    expect((await run()).recent_payout_change).toMatchObject({ status: "fail", severity: "warn" });
    world.indexerPayees = [{ payeeId: PAYEE, payout: PAYOUT, payoutUpdatedAt: iso(8 * DAY) }];
    expect((await run()).recent_payout_change?.status).toBe("pass");
    world.indexerPayees = [{ payeeId: PAYEE, payout: OTHER, payoutUpdatedAt: iso(30 * DAY) }];
    expect((await run()).recent_payout_change?.status).toBe("fail");
  });

  it("warns when this payee already has a lock with the same reference", async () => {
    world.indexerLocks = [{ id: "1", payeeId: PAYEE, refHash: REF }];
    expect((await run()).duplicate_ref_hash).toMatchObject({ status: "fail", severity: "warn" });
  });

  it("re-checks indexer results, so an indexer ignoring the filters can't cause a false result", async () => {
    world.indexerPayees = [
      { payeeId: "ab".repeat(32), payout: OTHER, payoutUpdatedAt: iso(DAY) },
      { payeeId: PAYEE, payout: PAYOUT, payoutUpdatedAt: null },
    ];
    world.indexerLocks = [
      { id: "1", payeeId: "ab".repeat(32), refHash: REF },
      { id: "2", payeeId: PAYEE, refHash: "11".repeat(32) },
    ];
    const r = await run();
    expect(r.recent_payout_change?.status).toBe("pass");
    expect(r.duplicate_ref_hash?.status).toBe("pass");
  });

  it("reports unknown (never pass) without an indexer, or when it can't be reached", async () => {
    const { indexerUrl: _, ...noIndexer } = config;
    const r = await run({}, noIndexer);
    expect(r.recent_payout_change?.messageKey).toBe("preflight.recent_payout_change.no_indexer");
    expect(r.duplicate_ref_hash?.messageKey).toBe("preflight.duplicate_ref_hash.no_indexer");
    world.indexerDown = true;
    const down = await run();
    expect(down.recent_payout_change?.status).toBe("unknown");
    expect(down.duplicate_ref_hash?.status).toBe("unknown");
    expect(down.sender_balance?.status).toBe("pass");
  });

  it("reports unknown when an RPC read fails", async () => {
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockRejectedValue(new Error("rpc down"));
    expect((await run()).payout_trustline_authorized?.status).toBe("unknown");
  });

  it("rejects invalid input", async () => {
    for (const bad of [
      { sender: "GABC" },
      { payeeId: "XY" },
      { refHash: REF.toUpperCase() },
      { total: 0n },
    ]) {
      await expect(preflight(config, { ...params, ...bad }, NOW)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it("fuzzes and rejects malformed Stellar StrKeys for sender, token, and recipient", async () => {
    const malformedAddresses = [
      // Truncated (short length)
      "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAM",
      // Too long
      "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3A",
      // Invalid checksum (corrupted last character)
      "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH4",
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMB",
      // Lowercase / mixed-case
      "gbbui4n57s3tbuztukqpkwy5dert2zhqn4llqz747w7cd5hu3fghwdh3",
      "cbieltk6ybzju5up2wwqeucyklpu6aunz2bq4wwfeie3uscihmxqdama",
      // Invalid base32 chars ('8', '9', '0', '1' in non-standard positions)
      "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH8",
      "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH9",
      // Unsupported key types: Secret seed (S-key)
      "SBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      // Multiplexed account (M-address, starts with M)
      "MAAAAAAAAAAAAAB7BQ2L7E5NBWMXDUCMZS5KGBGQBDT7UV5JOWUTDDQQFDNXAOQAAAAAAAAAAAC2K",
      // Signed payload account (starts with P)
      "PAAAAAAAAAAAAAB7BQ2L7E5NBWMXDUCMZS5KGBGQBDT7UV5JOWUTDDQQFDNXAOQAAAAAAAAAAAC2K",
      // Random strings and empty
      "",
      "not-a-stellar-key",
      "0x1234567890abcdef1234567890abcdef12345678",
    ];

    for (const badAddr of malformedAddresses) {
      // Test bad sender
      await expect(preflight(config, { ...params, sender: badAddr }, NOW)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining("sender is not a valid Stellar address"),
      });

      // Test bad token
      await expect(preflight(config, { ...params, token: badAddr }, NOW)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining("token is not a valid Stellar address"),
      });

      // Test bad direct recipient
      const { payeeId: _, ...directParams } = params;
      await expect(
        preflight(config, { ...directParams, recipient: badAddr }, NOW),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining("recipient is not a valid Stellar address"),
      });
    }
  });
});
