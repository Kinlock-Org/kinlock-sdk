# `@kinlock/sdk` API reference

Roadmap `M2-17`. Matches the exports in `src/index.ts` for `v0.3.0`. If this drifts from what's
actually exported, the exports are right and this file is stale, file an issue.

Every write (`createLock`, `release`, `refund`, `decline`) takes a `Signer` whose
`signTransaction` is the connected wallet's; the SDK never holds keys. Every read that a
money-moving page uses (`getLock`, `getPayee`) hits chain state directly, never the indexer.
Amounts are always `bigint` base units, never a JavaScript `number`.

## Client (`src/client.ts`)

### `createLock(config, params, signer)`

Builds, simulates, and submits `create_lock`. The signer must be the sender.

```ts
const { lockId, txHash } = await createLock(
  config,
  {
    sender: "G...",
    token: "C...",          // the USDC SAC address
    payeeId: "ab12...",     // 32 bytes hex
    tranches: [{ amount: 150_000_000n, unlockAt: 1_800_000_000n }],
    refHash: "cd34...",     // 32 bytes hex, sha256(reference || salt)
    expiresAt: 1_900_000_000n,
  },
  signer,
);
```

| Param | Type | Notes |
|---|---|---|
| `config` | `KinlockConfig` | `{ rpcUrl, networkPassphrase, contractId, allowHttp?, indexerUrl? }` |
| `params.sender` | `Address` | Must equal `signer.address`, or this throws before building a transaction |
| `params.token` | `Address` | The token's SAC contract address |
| `params.payeeId` | `Hash32` | 32 bytes as lowercase hex |
| `params.tranches` | `TrancheInput[]` | `{ amount: bigint, unlockAt: bigint }`; at least one, each `amount > 0n` |
| `params.refHash` | `Hash32` | `sha256(reference ‖ salt)`; use `computeRefHash` to build it |
| `params.expiresAt` | `bigint` | Unix seconds |

Returns `{ lockId: bigint, txHash: string }`. Throws `KinlockError` with code `INVALID_INPUT` for
bad params checked client-side, `CONTRACT_ERROR` (with `contractError` set to the contract's
error name, e.g. `"PayeeNotActive"`) if the chain rejects it, or `TX_FAILED` if signing or
submission fails.

### `release(config, { lockId, trancheIndex }, signer)`

The payee (the lock's payout address) claims one unlocked tranche. Returns `{ txHash: string }`.

### `refund(config, { lockId }, signer)`

The sender reclaims the unreleased remainder, once the contract allows it (expiry, payee Revoked,
or Suspended past grace). Returns `{ txHash: string }`.

### `decline(config, { lockId }, signer)`

The payee returns the unreleased remainder to the sender, any time while the lock is Open. Returns
`{ txHash: string }`.

### `getLock(config, lockId)`

Chain read by simulation; nothing is signed or sent. Returns the full `Lock` (see Types below), or
`null` if the id doesn't exist. **This is the only read money-moving pages may use.** Never
the indexer's cached copy.

### `getPayee(config, payeeId)`

Chain read of a registered payee. Returns `Payee` or `null`. Money-moving pages use this for the
refund rule (Revoked, or Suspended past grace); never backed by the indexer (ADR-0030).

## Preflight (`src/preflight.ts`)

### `preflight(config, params, now?)`

Runs five checks before a sender commits to `createLock`, in a fixed order. Returns
`PreflightResult[]`.

```ts
const results = await preflight(config, {
  sender: "G...", token: "C...", payeeId: "ab12...", total: 150_000_000n, refHash: "cd34...",
});
```

| Check | Severity | Source | Meaning on fail |
|---|---|---|---|
| `sender_balance` | block | chain | Sender doesn't hold enough of the token |
| `payee_active` | block | chain | Payee isn't registered, or isn't Active |
| `payout_trustline_authorized` | block | chain | The payout account can't currently receive the token (missing/unauthorized trustline, or no room under the limit) |
| `recent_payout_change` | warn | indexer | The payout address changed in the last 7 days (`RECENT_PAYOUT_CHANGE_WINDOW_SECS`) |
| `duplicate_ref_hash` | warn | indexer | A lock with this exact reference already exists for this payee |

Each result is `{ check, status: "pass" | "fail" | "unknown", severity: "block" | "warn",
messageKey }`. `"unknown"` means the check couldn't run (e.g. no `config.indexerUrl`, or the
indexer is unreachable) and is never treated as a pass. `messageKey` is a key for the app's
message files, not user-facing text, following the `preflight.<check>.<detail>` shape (see
`messages/en.json`'s `preflight` section for the actual strings).

## Receipts (`src/receipts.ts`)

### `verifyReceipt(config, ref)`

Verifies a receipt from chain data only, in tiers, and never throws except on malformed input.

```ts
const result = await verifyReceipt(config, { txHash: "ab12...", eventIndex: 0 });
// { valid: true, tier: "live_rpc", kind: "Released", reason: "verified", receipt: { lockId, amount, trancheIndex, payout, ledgerTime } }
```

- **Tier 1 (`live_rpc`):** the transaction is still within RPC retention. Every detail in the
  result comes straight from that event.
- **Tier 2 (`lock_state`):** older than RPC retention. The indexer is used only to look up which
  lock/tranche the event refers to; `getLock` then confirms it on chain. Payment is confirmed,
  transaction details (like `ledgerTime`) are not.
- **Tier 3 (`archive`):** not implemented yet (`M0-09`, `M2-16`). Receipts too old for tiers 1-2
  report `reason: "unverifiable"`, never `valid: true`.

`VerifyReceiptResult` is `{ valid, tier, kind, reason, receipt }`. `reason` is one of `"verified"`,
`"not_found"` (no such event), `"mismatch"` (the chain contradicts what's claimed), or
`"unverifiable"`.

## Links (`src/links.ts`)

Claim links carry the reference and salt **only in the URL fragment**, which browsers never send
to a server. Never log, persist, or transmit a claim link or anything parsed from one.

- **`buildClaimLink(origin, { lockId, reference, salt })`** -> `"https://.../claim/{lockId}#r=...&s=..."`
- **`parseClaimLink(link)`** -> `{ lockId, reference, salt }`
- **`buildRequestLink(origin, { payeeId, reference, schedule })`** -> `"https://.../send?payee=...&ref=...&schedule=..."`. Request links carry **no authority**; they only pre-fill the sender's form.
- **`parseRequestLink(link)`** -> `{ payeeId, reference, schedule: RequestTranche[] }`

`origin` must be `https://`, except `http://localhost` / `http://127.0.0.1` for local dev.

## Hashing (`src/hash.ts`)

- **`generateSalt()`** -> 16 random bytes from the platform CSPRNG, as unpadded base64url (22 characters).
- **`computeRefHash(reference, salt)`** -> `Promise<Hash32>`, the 32-byte `sha256(NFC-normalized reference ‖ salt bytes)` as lowercase hex, matching the contract's `ref_hash`.

## Amount formatting (`src/format.ts`)

The *only* place base-unit/decimal conversion happens. USDC uses 7 decimals
(`USDC_DECIMALS`). Conversions are exact: more decimal places than the token has throws, never
rounds, because a rounded amount is a different amount of money. Locale-aware display (`Intl`)
belongs in the app, not here.

- **`toBaseUnits(decimal, decimals = USDC_DECIMALS)`** -> `bigint`. `"12.5"` -> `125000000n`.
- **`fromBaseUnits(amount, decimals = USDC_DECIMALS)`** -> `string`. `125000000n` -> `"12.5"`. Trailing zeros dropped; integers have no dot.

## Errors (`src/errors.ts`)

Every SDK function throws `KinlockError` (never a bare `Error`), with a stable `code`:

| Code | Meaning |
|---|---|
| `INVALID_INPUT` / `INVALID_AMOUNT` / `INVALID_REFERENCE` / `INVALID_LINK` | Caught client-side before touching the network |
| `CONTRACT_ERROR` | The contract rejected the call; `error.contractError` holds its error name (`kinlock-contracts` `errors.rs`), e.g. `"NotYetUnlocked"` |
| `TX_FAILED` | Signing, submission, or confirmation failed, including the wallet declining |
| `NOT_IMPLEMENTED` | Thrown by scaffolded functions that don't exist yet |

`error.message` is for developers (logs, error boundaries), never shown to an end user directly;
the app maps `code`/`contractError` to a message-file key. `NotImplementedError` is a
`KinlockError` subclass (`code: "NOT_IMPLEMENTED"`) thrown by scaffolded functions that don't
exist yet; it isn't thrown by anything documented above.

## Types (`src/types.ts`)

`Address` and `Hash32` are both plain `string` (a Stellar address, and 32 bytes as lowercase hex,
respectively). `Lock`, `Payee`, `Tranche`, `TrancheInput` mirror the contract's data model field
for field; see the file for the exact shape. `Category` is `"School" | "Rent"`, `PayeeStatus` is
`"Active" | "Suspended" | "Revoked"`, `LockState` is `"Open" | "Completed" | "Refunded" |
"Declined"`, `RefundReason` is `"Expired" | "Revoked" | "SuspendedTimeout"`.
