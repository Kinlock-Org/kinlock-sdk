/**
 * Pre-flight checks shared by the app and third parties. Roadmap M2-05. [sec]
 *
 * Chain checks (they block a send when they fail): sender balance, payee Active, and an
 * authorized trustline with room for the amount on the payout account.
 * Indexer checks (they only warn): a payout change in the last 7 days, and a lock that already
 * uses this reference for this payee. The contract stores neither, so they need
 * `config.indexerUrl`; without it, or if the indexer can't be reached, they report "unknown".
 * Nothing here signs or sends a transaction.
 */
import { Client } from "@kinlock/contract";
import {
  Account,
  Asset,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  StrKey,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { z } from "zod";
import type { KinlockConfig } from "./client.js";
import { KinlockError } from "./errors.js";
import type { Address, Hash32 } from "./types.js";

/** Payout changes within this window trigger a warning to the sender. */
export const RECENT_PAYOUT_CHANGE_WINDOW_SECS = 7n * 24n * 60n * 60n;

export type PreflightCheck =
  | "sender_balance"
  | "payee_active"
  | "recent_payout_change"
  | "duplicate_ref_hash"
  | "payout_trustline_authorized";

export interface PreflightResult {
  check: PreflightCheck;
  /** "unknown": the check couldn't be completed (e.g. indexer unreachable). Never a pass. */
  status: "pass" | "fail" | "unknown";
  /** "block": don't let the sender continue on fail. "warn": show it, let them decide. */
  severity: "block" | "warn";
  /** Message key for the app to translate; no user-facing text here. */
  messageKey: string;
}

export interface PreflightParams {
  sender: Address;
  token: Address;
  payeeId?: Hash32;
  recipient?: Address;
  total: bigint;
  refHash: Hash32;
}

const SEVERITY: Record<PreflightCheck, PreflightResult["severity"]> = {
  sender_balance: "block",
  payee_active: "block",
  payout_trustline_authorized: "block",
  recent_payout_change: "warn",
  duplicate_ref_hash: "warn",
};

const result = (
  check: PreflightCheck,
  status: PreflightResult["status"],
  detail?: string,
): PreflightResult => ({
  check,
  status,
  severity: SEVERITY[check],
  messageKey: `preflight.${check}.${detail ?? status}`,
});

/** Trustline flag: the issuer has authorized the account to hold the asset. */
const AUTHORIZED_FLAG = 1;
// Read-only simulations need a well-formed source account; it is never charged or signed for.
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function server(config: KinlockConfig): rpc.Server {
  return new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp ?? false });
}

/** Call a read-only contract function by simulation and return its value. */
async function read(
  config: KinlockConfig,
  contractId: Address,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server(config).simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`${method} simulation failed`);
  }
  return scValToNative(sim.result.retval);
}

async function senderBalance(config: KinlockConfig, p: PreflightParams): Promise<PreflightResult> {
  const balance = await read(config, p.token, "balance", [
    nativeToScVal(p.sender, { type: "address" }),
  ]);
  if (typeof balance !== "bigint") throw new Error("unexpected balance type");
  return result("sender_balance", balance >= p.total ? "pass" : "fail");
}

/** USDC-style trustline on a classic payout account. Contract (C) accounts hold SAC balances
 *  without a trustline, and the native asset needs none. */
async function payoutTrustline(
  config: KinlockConfig,
  p: PreflightParams,
  payout: Address,
): Promise<PreflightResult> {
  const check = "payout_trustline_authorized";
  if (StrKey.isValidContract(payout)) return result(check, "pass", "contract_account");
  const name = await read(config, p.token, "name");
  if (name === "native") return result(check, "pass", "native_asset");
  const [code, issuer] = String(name).split(":");
  if (!code || !issuer) throw new Error(`unexpected token name ${String(name)}`);
  if (issuer === payout) return result(check, "pass", "issuer_account");
  const key = xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(payout).xdrAccountId(),
      asset: new Asset(code, issuer).toTrustLineXdrObject(),
    }),
  );
  const { entries } = await server(config).getLedgerEntries(key);
  const entry = entries[0];
  if (!entry) return result(check, "fail", "missing");
  const rawVal = entry.val as unknown as Record<string, unknown>;
  const entryType =
    typeof rawVal.type === "string"
      ? rawVal.type
      : typeof rawVal.switch === "function"
        ? ((rawVal.switch as () => { name?: string })().name ?? (rawVal.switch as () => unknown)())
        : undefined;
  if (entryType !== "trustline") throw new Error(`unexpected ledger entry ${String(entryType)}`);
  const lineCandidate =
    typeof rawVal.trustLine === "function"
      ? (rawVal.trustLine as () => unknown)()
      : (rawVal.trustLine ?? rawVal.value);
  if (!lineCandidate || typeof lineCandidate !== "object") {
    throw new Error("missing trustline data in ledger entry");
  }
  const line = lineCandidate as Record<string, unknown>;
  const rawFlags = typeof line.flags === "function" ? (line.flags as () => unknown)() : line.flags;
  const rawLimit = typeof line.limit === "function" ? (line.limit as () => unknown)() : line.limit;
  const rawBalance =
    typeof line.balance === "function" ? (line.balance as () => unknown)() : line.balance;

  const flags = Number(rawFlags);
  const limit = BigInt(rawLimit as bigint | number | string);
  const balance = BigInt(rawBalance as bigint | number | string);
  if ((flags & AUTHORIZED_FLAG) === 0) return result(check, "fail", "not_authorized");
  const room = limit - balance;
  return result(check, room >= p.total ? "pass" : "fail", room >= p.total ? "pass" : "limit");
}

const IndexerPayees = z.object({
  payees: z.array(
    z.object({ payeeId: z.string(), payout: z.string(), payoutUpdatedAt: z.string().nullable() }),
  ),
});
const IndexerLocks = z.object({
  locks: z.array(z.object({ id: z.string(), payeeId: z.string().nullable(), refHash: z.string() })),
});

async function indexerGet<T>(
  config: KinlockConfig,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(new URL(path, config.indexerUrl), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`indexer ${path}: HTTP ${response.status}`);
  return schema.parse(await response.json());
}

async function recentPayoutChange(
  config: KinlockConfig,
  p: PreflightParams,
  chainPayout: Address,
  now: bigint,
): Promise<PreflightResult> {
  const check = "recent_payout_change";
  if (!config.indexerUrl) return result(check, "unknown", "no_indexer");
  const { payees } = await indexerGet(config, `/payees?payee_id=${p.payeeId}`, IndexerPayees);
  // Re-check the id: an indexer without this filter would return every payee.
  const indexed = payees.find((x) => x.payeeId === p.payeeId);
  if (!indexed) return result(check, "unknown", "not_indexed");
  // The chain has a payout the indexer hasn't seen yet: it changed very recently.
  if (indexed.payout !== chainPayout) return result(check, "fail");
  if (!indexed.payoutUpdatedAt) return result(check, "pass");
  const changedAt = BigInt(Math.floor(Date.parse(indexed.payoutUpdatedAt) / 1000));
  return result(check, now - changedAt < RECENT_PAYOUT_CHANGE_WINDOW_SECS ? "fail" : "pass");
}

async function duplicateRefHash(
  config: KinlockConfig,
  p: PreflightParams,
): Promise<PreflightResult> {
  const check = "duplicate_ref_hash";
  if (!config.indexerUrl) return result(check, "unknown", "no_indexer");
  const { locks } = await indexerGet(
    config,
    `/locks?payee_id=${p.payeeId}&ref_hash=${p.refHash}&limit=100`,
    IndexerLocks,
  );
  // Re-check both fields: an indexer without the ref_hash filter would return other locks.
  const duplicate = locks.some((l) => l.payeeId === p.payeeId && l.refHash === p.refHash);
  return result(check, duplicate ? "fail" : "pass");
}

function checkParams(p: PreflightParams): void {
  const bad = (m: string) => new KinlockError(m, "INVALID_INPUT");
  for (const [field, value] of [
    ["sender", p.sender],
    ["token", p.token],
  ] as const) {
    if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
      throw bad(`${field} is not a valid Stellar address`);
    }
  }
  if (p.recipient !== undefined) {
    if (!StrKey.isValidEd25519PublicKey(p.recipient) && !StrKey.isValidContract(p.recipient)) {
      throw bad("recipient is not a valid Stellar address");
    }
  } else if (p.payeeId !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(p.payeeId)) throw bad("payeeId must be 32 bytes as lowercase hex");
  } else {
    throw bad("either payeeId or recipient must be provided");
  }
  if (!/^[0-9a-f]{64}$/.test(p.refHash)) throw bad("refHash must be 32 bytes as lowercase hex");
  if (typeof p.total !== "bigint" || p.total <= 0n) throw bad("total must be a positive bigint");
}

/** A check that throws becomes "unknown" instead of failing the whole preflight. */
async function settle(
  check: PreflightCheck,
  run: () => Promise<PreflightResult>,
): Promise<PreflightResult> {
  try {
    return await run();
  } catch {
    return result(check, "unknown");
  }
}

/** Run all five checks. Results are in a fixed order: the order of `PreflightCheck`. */
export async function preflight(
  config: KinlockConfig,
  params: PreflightParams,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<PreflightResult[]> {
  checkParams(params);
  // The payee read feeds three checks (status, trustline, payout change).
  let payout: Address | undefined = params.recipient;
  const payeeActive = params.recipient
    ? Promise.resolve(result("payee_active", "pass"))
    : await settle("payee_active", async () => {
        if (!params.payeeId) {
          return result("payee_active", "fail", "not_found");
        }
        const payeeId = params.payeeId;
        const tx = await new Client({
          contractId: config.contractId,
          networkPassphrase: config.networkPassphrase,
          rpcUrl: config.rpcUrl,
          allowHttp: config.allowHttp ?? false,
        }).get_payee({ payee_id: Buffer.from(payeeId, "hex") });
        if (tx.result.isErr()) {
          const name = tx.result.unwrapErr().message.split(":")[0];
          return result(
            "payee_active",
            name === "PayeeNotFound" ? "fail" : "unknown",
            name === "PayeeNotFound" ? "not_found" : undefined,
          );
        }
        const payee = tx.result.unwrap();
        payout = payee.payout;
        return result(
          "payee_active",
          payee.status.tag === "Active" ? "pass" : "fail",
          payee.status.tag === "Active" ? "pass" : payee.status.tag.toLowerCase(),
        );
      });
  const withPayout = (check: PreflightCheck, run: (payout: Address) => Promise<PreflightResult>) =>
    settle(check, () =>
      payout ? run(payout) : Promise.resolve(result(check, "unknown", "no_payee")),
    );

  const [balance, activeResult, payoutChange, duplicate, trustline] = await Promise.all([
    settle("sender_balance", () => senderBalance(config, params)),
    payeeActive,
    params.recipient
      ? Promise.resolve(result("recent_payout_change", "pass"))
      : withPayout("recent_payout_change", (po) => recentPayoutChange(config, params, po, now)),
    settle("duplicate_ref_hash", () => duplicateRefHash(config, params)),
    withPayout("payout_trustline_authorized", (po) => payoutTrustline(config, params, po)),
  ]);
  return [balance, activeResult, payoutChange, duplicate, trustline];
}
