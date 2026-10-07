#!/usr/bin/env node
// Testnet integration check for the SDK client (roadmap M2-02). Not run in CI: it moves real
// testnet USDC and needs the `stellar` CLI with the testnet identities on this machine.
//
//   pnpm --filter @kinlock/sdk build && node packages/sdk/scripts/testnet-smoke.mjs
//   node packages/sdk/scripts/testnet-smoke.mjs --refund <lockId>   # once that lock has expired
//
// Signing goes through `stellar tx sign --sign-with-key <identity>`: keys stay in the CLI's
// keystore and are never read here. TESTNET ONLY.
import { execFileSync } from "node:child_process";
import {
  computeRefHash,
  createLock,
  decline,
  generateSalt,
  getLock,
  preflight,
  refund,
  release,
} from "../dist/index.js";

const config = {
  rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId:
    process.env.KINLOCK_CONTRACT_ID ?? "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
  indexerUrl: process.env.KINLOCK_INDEXER_URL ?? "https://indexer-production-705a.up.railway.app",
};
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
/** A fixture payee registered on testnet (kinlock-registry fixtures). */
const PAYEE_ID = "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba";
const SENDER = process.env.KINLOCK_SENDER_IDENTITY ?? "kinlock-testnet-sender-1";
const PAYEE = process.env.KINLOCK_PAYEE_IDENTITY ?? "kinlock-testnet-payee-ke";

function cliSigner(identity) {
  const address = execFileSync("stellar", ["keys", "address", identity]).toString().trim();
  return {
    address,
    signTransaction: async (xdr) => ({
      signedTxXdr: execFileSync(
        "stellar",
        ["tx", "sign", "--sign-with-key", identity, "--network", "testnet"],
        { input: xdr },
      )
        .toString()
        .trim(),
      signerAddress: address,
    }),
  };
}

function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  console.log(`✓ ${message}`);
}

const sender = cliSigner(SENDER);
const refundId = process.argv.indexOf("--refund");
if (refundId > 0) {
  const lockId = BigInt(process.argv[refundId + 1]);
  const { txHash } = await refund(config, { lockId }, sender);
  const lock = await getLock(config, lockId);
  check(lock?.state === "Refunded", `lock ${lockId} refunded (tx ${txHash})`);
  process.exit(0);
}

const payee = cliSigner(PAYEE);
const now = BigInt(Math.floor(Date.now() / 1000));
const refHash = await computeRefHash("SMOKE-TEST-INVOICE", generateSalt());
const checks = await preflight(config, {
  sender: sender.address,
  token: USDC,
  payeeId: PAYEE_ID,
  total: 10000000n,
  refHash,
});
console.log(checks.map((c) => `  ${c.check}: ${c.status} (${c.severity})`).join("\n"));
check(
  checks.every((c) => c.severity !== "block" || c.status === "pass"),
  "preflight: no blocking check fails",
);
check(
  checks.every((c) => c.status !== "unknown"),
  "preflight: every check completed (chain and indexer reachable)",
);
const { lockId, txHash } = await createLock(
  config,
  {
    sender: sender.address,
    token: USDC,
    payeeId: PAYEE_ID,
    tranches: [
      { amount: 5000000n, unlockAt: now - 60n },
      { amount: 5000000n, unlockAt: now - 60n },
    ],
    refHash,
    expiresAt: now + 3700n,
  },
  sender,
);
console.log(`created lock ${lockId} (tx ${txHash})`);

let lock = await getLock(config, lockId);
check(lock?.state === "Open" && lock.total === 10000000n, "getLock reads the new lock from chain");
check(lock?.refHash === refHash, "ref_hash on chain matches the one computed locally");

const rel = await release(config, { lockId, trancheIndex: 0 }, payee);
lock = await getLock(config, lockId);
check(
  lock?.released === 5000000n && lock.tranches[0]?.released,
  `tranche 0 released (tx ${rel.txHash})`,
);

const early = await refund(config, { lockId }, sender).catch((e) => e);
check(
  early?.code === "CONTRACT_ERROR" && early.contractError === "RefundNotAllowed",
  "early refund refused by the contract (RefundNotAllowed)",
);

const dec = await decline(config, { lockId }, payee);
lock = await getLock(config, lockId);
check(
  lock?.state === "Declined" && lock.returned === 5000000n,
  `remainder declined back to the sender (tx ${dec.txHash})`,
);

check((await getLock(config, 2n ** 40n)) === null, "getLock returns null for an unknown lock");
