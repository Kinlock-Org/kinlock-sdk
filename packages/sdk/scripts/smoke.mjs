#!/usr/bin/env node
// Integration check for the SDK client (roadmap M2-02, M2-05) against a real network. Not run in
// CI: it moves tokens and needs the `stellar` CLI with the network's identities on this machine.
//
//   pnpm --filter @kinlock/sdk build && node packages/sdk/scripts/smoke.mjs        # testnet
//   node packages/sdk/scripts/smoke.mjs --refund <lockId>                          # once expired
//
// Local quickstart network (scripts/localnet.sh in kinlock-contracts):
//   KINLOCK_NETWORK=local STELLAR_RPC_URL=http://localhost:8000/rpc KINLOCK_CONTRACT_ID=C… \
//   KINLOCK_TOKEN=C… KINLOCK_PAYEE_ID=<hex> KINLOCK_SENDER_IDENTITY=… KINLOCK_PAYEE_IDENTITY=… \
//   KINLOCK_INDEXER_URL= node packages/sdk/scripts/smoke.mjs
//
// Signing goes through `stellar tx sign --sign-with-key <identity>`: keys stay in the CLI's
// keystore and are never read here. Testnet or local only.
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

const NETWORKS = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    rpc: "https://soroban-testnet.stellar.org",
  },
  local: { passphrase: "Standalone Network ; February 2017", rpc: "http://localhost:8000/rpc" },
};
const NETWORK = process.env.KINLOCK_NETWORK ?? "testnet";
const net = NETWORKS[NETWORK];
if (!net) throw new Error(`KINLOCK_NETWORK must be testnet or local, not ${NETWORK}`);
const testnet = NETWORK === "testnet";

const env = (name, testnetDefault) => {
  const value = process.env[name] ?? (testnet ? testnetDefault : undefined);
  if (value === undefined) throw new Error(`set ${name} for the ${NETWORK} network`);
  return value;
};

const rpcUrl = process.env.STELLAR_RPC_URL ?? net.rpc;
// An empty KINLOCK_INDEXER_URL means "no indexer": preflight's two warnings report unknown.
const indexerUrl = env("KINLOCK_INDEXER_URL", "https://indexer-production-705a.up.railway.app");
const config = {
  rpcUrl,
  networkPassphrase: net.passphrase,
  contractId: env(
    "KINLOCK_CONTRACT_ID",
    "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
  ),
  allowHttp: rpcUrl.startsWith("http://"),
  ...(indexerUrl ? { indexerUrl } : {}),
};
const USDC = env("KINLOCK_TOKEN", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
/** On testnet, a fixture payee from kinlock-registry. */
const PAYEE_ID = env(
  "KINLOCK_PAYEE_ID",
  "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba",
);
const SENDER = env("KINLOCK_SENDER_IDENTITY", "kinlock-testnet-sender-1");
const PAYEE = env("KINLOCK_PAYEE_IDENTITY", "kinlock-testnet-payee-ke");
console.log(`network: ${NETWORK} (${rpcUrl})`);

function cliSigner(identity) {
  const address = execFileSync("stellar", ["keys", "address", identity]).toString().trim();
  return {
    address,
    signTransaction: async (xdr) => ({
      signedTxXdr: execFileSync(
        "stellar",
        ["tx", "sign", "--sign-with-key", identity, "--network", NETWORK],
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
  checks.every((c) => c.status !== "unknown" || (!indexerUrl && c.severity === "warn")),
  indexerUrl
    ? "preflight: every check completed (chain and indexer reachable)"
    : "preflight: every chain check completed (no indexer configured)",
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
