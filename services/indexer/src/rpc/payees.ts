/**
 * Reads a payee's current state from chain by simulating `get_payee` (no transaction is sent).
 * Roadmap M2-28: RPC history holds about eight days of events, so a payee registered before the
 * oldest retained ledger has no replayable `PayeeRegistered` event. Its state, unlike its history,
 * is always readable. Same shape as `rpc/locks.ts`, and the same contract the SDK's `getPayee`
 * (ADR-0030) reads.
 */
import {
  Account,
  Contract,
  nativeToScVal,
  rpc,
  StrKey,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { SIMULATION_SOURCE } from "./locks.js";

/** A payee as it is on chain right now. Amount-free, so no decimal-string concerns here. */
export interface ChainPayee {
  payout: string;
  attester: string;
  category: "School" | "Rent";
  status: "Active" | "Suspended" | "Revoked";
  /** Lowercase hex, as the event handlers store it. */
  metaHash: string;
  /** Unix seconds. */
  registeredAt: bigint;
  statusChangedAt: bigint;
}

export interface PayeeReader {
  /** Current chain state, or `undefined` when this contract has no payee registered under that id. */
  read(payeeId: string): Promise<ChainPayee | undefined>;
}

const address = z
  .string()
  .refine((s) => StrKey.isValidEd25519PublicKey(s) || StrKey.isValidContract(s), "invalid address");

// A stored contract enum decodes as a one-element vec of the variant name, e.g. ["School"].
// Variants are append-only: kinlock-contracts `types.rs` Category and PayeeStatus.
const PayeeSchema = z.object({
  payout: address,
  attester: address,
  category: z.tuple([z.enum(["School", "Rent"])]),
  status: z.tuple([z.enum(["Active", "Suspended", "Revoked"])]),
  meta_hash: z.instanceof(Uint8Array),
  registered_at: z.bigint(),
  status_changed_at: z.bigint(),
});

/** `errors.rs`: PayeeNotFound = 11. Codes are the contract's public error interface. */
const PAYEE_NOT_FOUND = 11;

/** The contract error code a simulation failure reports, e.g. `#11` in "HostError: Error(Contract, #11)". */
export function contractErrorCode(error: string | undefined): number | undefined {
  const found = error?.split("\n")[0]?.match(/Error\(Contract, #(\d+)\)/);
  return found ? Number(found[1]) : undefined;
}

export function createPayeeReader(
  urls: string[],
  networkPassphrase: string,
  contractId: string,
): PayeeReader {
  const contract = new Contract(contractId);
  return {
    async read(payeeId) {
      const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
        fee: "100",
        networkPassphrase,
      })
        .addOperation(contract.call("get_payee", nativeToScVal(Buffer.from(payeeId, "hex"))))
        .setTimeout(30)
        .build();
      const failures: string[] = [];
      for (const url of urls) {
        let sim: rpc.Api.SimulateTransactionResponse;
        try {
          sim = await new rpc.Server(url, {
            allowHttp: url.startsWith("http://"),
          }).simulateTransaction(tx);
        } catch (e) {
          failures.push(`${url}: ${(e as Error).message}`);
          continue;
        }
        if (rpc.Api.isSimulationSuccess(sim)) {
          if (!sim.result) throw new Error(`get_payee(${payeeId}): simulation returned no result`);
          const payee = PayeeSchema.parse(scValToNative(sim.result.retval));
          return {
            payout: payee.payout,
            attester: payee.attester,
            category: payee.category[0],
            status: payee.status[0],
            metaHash: Buffer.from(payee.meta_hash).toString("hex"),
            registeredAt: payee.registered_at,
            statusChangedAt: payee.status_changed_at,
          };
        }
        const error = "error" in sim ? sim.error : undefined;
        if (contractErrorCode(error) === PAYEE_NOT_FOUND) return undefined;
        throw new Error(
          `get_payee(${payeeId}) failed: ${error?.split("\n")[0] ?? "no result (state may be archived)"}`,
        );
      }
      throw new Error(`get_payee(${payeeId}): all RPC providers failed: ${failures.join("; ")}`);
    },
  };
}
