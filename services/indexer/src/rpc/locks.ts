/**
 * Reads a lock's tranche schedule from chain by simulating `get_lock` (no transaction is sent).
 * LockCreated carries only `tranche_count`; amounts and unlock times come from here.
 */
import {
  Account,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import type { TrancheSchedule } from "../handlers/types.js";

export interface LockReader {
  tranches(lockId: bigint): Promise<TrancheSchedule[]>;
}

const LockSchema = z.object({
  tranches: z.array(z.object({ amount: z.bigint(), unlock_at: z.bigint() })).min(1),
});

// Simulation needs a well-formed source account; it is never charged or signed for.
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export function createLockReader(
  urls: string[],
  networkPassphrase: string,
  contractId: string,
): LockReader {
  const contract = new Contract(contractId);
  return {
    async tranches(lockId) {
      const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
        fee: "100",
        networkPassphrase,
      })
        .addOperation(contract.call("get_lock", nativeToScVal(lockId, { type: "u64" })))
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
        if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
          throw new Error(
            `get_lock(${lockId}) failed: ${"error" in sim ? sim.error : "no result"}`,
          );
        }
        const lock = LockSchema.parse(scValToNative(sim.result.retval));
        return lock.tranches.map((t) => ({ amount: t.amount, unlockAt: t.unlock_at }));
      }
      throw new Error(`get_lock(${lockId}): all RPC providers failed: ${failures.join("; ")}`);
    },
  };
}
