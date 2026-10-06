/**
 * Soroban RPC client with multi-provider failover (STELLAR_RPC_URLS). Roadmap M2-08.
 * RPC history is limited: missing history is a gap, never "no events".
 */
export interface RpcEvent {
  ledger: bigint;
  ledgerClosedAt: string;
  txHash: string;
  eventIndex: number;
  id: string;
  topic: unknown[];
  value: unknown;
}

export interface RpcClient {
  getLatestLedger(): Promise<bigint>;
  getEvents(
    fromLedger: bigint,
    cursor: string | null,
  ): Promise<{ events: RpcEvent[]; cursor: string | null }>;
}
