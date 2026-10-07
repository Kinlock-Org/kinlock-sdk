import { Err, Ok } from "@stellar/stellar-sdk/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

const methods = {
  get_lock: vi.fn(),
  get_payee: vi.fn(),
  create_lock: vi.fn(),
  release: vi.fn(),
  refund: vi.fn(),
  decline: vi.fn(),
};
const constructed: unknown[] = [];
vi.mock("@kinlock/contract", () => ({
  Client: vi.fn(function (this: unknown, options: unknown) {
    constructed.push(options);
    return methods;
  }),
}));

const { createLock, decline, getLock, getPayee, refund, release } = await import("../client.js");
const { KinlockError } = await import("../errors.js");

const config = {
  rpcUrl: "https://rpc.example",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
};
const SENDER = "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3";
const PAYOUT = "GCLMHF7LAR34TSELDNEREYPTNE4K7MMESPS62WXE7ZDLPWIJUF3MC5QM";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const H1 = "44".repeat(32);
const H2 = "de".repeat(32);
const signer = (address = SENDER) => ({ address, signTransaction: vi.fn() });

/** An AssembledTransaction stand-in: simulation result plus signAndSend. */
function tx<T>(simulated: unknown, sent?: { result: unknown; hash?: string } | Error) {
  return {
    result: simulated,
    signAndSend: vi.fn(async () => {
      if (sent instanceof Error) throw sent;
      return { result: sent?.result, sendTransactionResponse: { hash: sent?.hash } };
    }),
  } as unknown as T;
}

const rawLock = {
  id: 7n,
  sender: SENDER,
  payee_id: Buffer.from(H1, "hex"),
  payout: PAYOUT,
  token: USDC,
  total: 100000000n,
  released: 50000000n,
  returned: 0n,
  ref_hash: new Uint8Array(Buffer.from(H2, "hex")),
  tranches: [
    { amount: 50000000n, unlock_at: 1791299418n, released: true },
    { amount: 50000000n, unlock_at: 1791299418n, released: false },
  ],
  expires_at: 1791306618n,
  state: { tag: "Open", values: undefined },
  created_at: 1791299432n,
};

beforeEach(() => {
  for (const m of Object.values(methods)) m.mockReset();
  constructed.length = 0;
});

describe("getLock", () => {
  it("maps the chain lock to SDK types (hex hashes, bigint amounts, state tag)", async () => {
    methods.get_lock.mockResolvedValue(tx(new Ok(rawLock)));
    const lock = await getLock(config, 7n);
    expect(lock).toEqual({
      id: 7n,
      sender: SENDER,
      payeeId: H1,
      payout: PAYOUT,
      token: USDC,
      total: 100000000n,
      released: 50000000n,
      returned: 0n,
      refHash: H2,
      tranches: [
        { amount: 50000000n, unlockAt: 1791299418n, released: true },
        { amount: 50000000n, unlockAt: 1791299418n, released: false },
      ],
      expiresAt: 1791306618n,
      state: "Open",
      createdAt: 1791299432n,
    });
    expect(methods.get_lock).toHaveBeenCalledWith({ lock_id: 7n });
    // A read needs no signer, so no source account is set.
    expect(constructed[0]).toMatchObject({ contractId: config.contractId });
    expect(constructed[0]).not.toHaveProperty("publicKey");
  });

  it("returns null for an unknown lock", async () => {
    methods.get_lock.mockResolvedValue(
      tx(new Err({ message: "LockNotFound: no lock exists with this ID." })),
    );
    expect(await getLock(config, 999n)).toBeNull();
  });

  it("throws other contract errors with the error name", async () => {
    methods.get_lock.mockResolvedValue(tx(new Err({ message: "NotInitialized: no config." })));
    await expect(getLock(config, 1n)).rejects.toMatchObject({
      code: "CONTRACT_ERROR",
      contractError: "NotInitialized",
    });
  });

  it("rejects a bad lock id or contract id without calling the network", async () => {
    await expect(getLock(config, -1n)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(getLock({ ...config, contractId: SENDER }, 1n)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(methods.get_lock).not.toHaveBeenCalled();
  });
});

describe("createLock", () => {
  const params = {
    sender: SENDER,
    token: USDC,
    payeeId: H1,
    tranches: [{ amount: 10000000n, unlockAt: 1n }],
    refHash: H2,
    expiresAt: 1791306618n,
  };

  it("simulates, has the wallet sign, sends, and returns the new lock id", async () => {
    const t = tx(new Ok(9n), { result: new Ok(9n), hash: "ab".repeat(32) });
    methods.create_lock.mockResolvedValue(t);
    const s = signer();
    expect(await createLock(config, params, s)).toEqual({ lockId: 9n, txHash: "ab".repeat(32) });
    expect(methods.create_lock).toHaveBeenCalledWith({
      sender: SENDER,
      token: USDC,
      payee_id: Buffer.from(H1, "hex"),
      tranches: [{ amount: 10000000n, unlock_at: 1n }],
      ref_hash: Buffer.from(H2, "hex"),
      expires_at: 1791306618n,
    });
    expect(constructed[0]).toMatchObject({ publicKey: SENDER });
    expect((t as { signAndSend: ReturnType<typeof vi.fn> }).signAndSend).toHaveBeenCalledWith({
      signTransaction: s.signTransaction,
    });
  });

  it("stops at a simulation error without asking the wallet to sign", async () => {
    const t = tx(new Err({ message: "PayeeNotActive: the payee is not Active." }));
    methods.create_lock.mockResolvedValue(t);
    const error = await createLock(config, params, signer()).catch((e) => e);
    expect(error).toBeInstanceOf(KinlockError);
    expect(error).toMatchObject({ code: "CONTRACT_ERROR", contractError: "PayeeNotActive" });
    expect((t as { signAndSend: ReturnType<typeof vi.fn> }).signAndSend).not.toHaveBeenCalled();
  });

  it("reports a failed or declined signing as TX_FAILED", async () => {
    methods.create_lock.mockResolvedValue(tx(new Ok(9n), new Error("User declined")));
    await expect(createLock(config, params, signer())).rejects.toMatchObject({
      code: "TX_FAILED",
    });
  });

  it("validates input before touching the network", async () => {
    const bad = [
      { ...params, sender: "GABC" },
      { ...params, payeeId: "XY" },
      { ...params, refHash: H2.toUpperCase() },
      { ...params, tranches: [] },
      { ...params, tranches: [{ amount: 0n, unlockAt: 1n }] },
      { ...params, expiresAt: -1n },
    ];
    for (const p of bad) {
      await expect(createLock(config, p, signer())).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    // The signer must be the sender: the contract requires the sender's authorization.
    await expect(createLock(config, params, signer(PAYOUT))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(methods.create_lock).not.toHaveBeenCalled();
  });
});

describe("release, refund, decline", () => {
  it("release passes the tranche index and signs as the given signer", async () => {
    methods.release.mockResolvedValue(
      tx(new Ok(undefined), { result: new Ok(undefined), hash: "cd".repeat(32) }),
    );
    expect(await release(config, { lockId: 1n, trancheIndex: 0 }, signer(PAYOUT))).toEqual({
      txHash: "cd".repeat(32),
    });
    expect(methods.release).toHaveBeenCalledWith({ lock_id: 1n, idx: 0 });
    expect(constructed[0]).toMatchObject({ publicKey: PAYOUT });
  });

  it("surfaces the contract's reason when an action isn't allowed", async () => {
    methods.refund.mockResolvedValue(
      tx(new Err({ message: "NotRefundable: the lock can't be refunded yet." })),
    );
    await expect(refund(config, { lockId: 2n }, signer())).rejects.toMatchObject({
      code: "CONTRACT_ERROR",
      contractError: "NotRefundable",
    });
    methods.decline.mockResolvedValue(
      tx(
        new Err({ message: "LockNotOpen: the lock is already completed, refunded, or declined." }),
      ),
    );
    await expect(decline(config, { lockId: 1n }, signer(PAYOUT))).rejects.toMatchObject({
      contractError: "LockNotOpen",
    });
  });

  it("rejects a bad tranche index", async () => {
    await expect(
      release(config, { lockId: 1n, trancheIndex: -1 }, signer(PAYOUT)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      release(config, { lockId: 1n, trancheIndex: 1.5 }, signer(PAYOUT)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("getPayee", () => {
  it("maps the chain payee to SDK types (hex meta hash, status and category names)", async () => {
    methods.get_payee.mockResolvedValue(
      tx(
        new Ok({
          payout: PAYOUT,
          category: { tag: "School", values: undefined },
          status: { tag: "Suspended", values: undefined },
          status_changed_at: 1791300000n,
          attester: SENDER,
          meta_hash: Buffer.from(H2, "hex"),
          registered_at: 1791200000n,
        }),
      ),
    );
    expect(await getPayee(config, H1)).toEqual({
      payout: PAYOUT,
      category: "School",
      status: "Suspended",
      statusChangedAt: 1791300000n,
      attester: SENDER,
      metaHash: H2,
      registeredAt: 1791200000n,
    });
    expect(methods.get_payee).toHaveBeenCalledWith({ payee_id: Buffer.from(H1, "hex") });
    expect(constructed[0]).not.toHaveProperty("publicKey");
  });

  it("returns null for an unregistered payee, throws other errors, rejects bad ids", async () => {
    methods.get_payee.mockResolvedValue(
      tx(new Err({ message: "PayeeNotFound: no payee with this ID." })),
    );
    expect(await getPayee(config, H1)).toBeNull();
    methods.get_payee.mockResolvedValue(tx(new Err({ message: "NotInitialized: no config." })));
    await expect(getPayee(config, H1)).rejects.toMatchObject({ contractError: "NotInitialized" });
    await expect(getPayee(config, "XY")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
