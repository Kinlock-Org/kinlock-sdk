/** Persisted cursor (`indexer_cursor`). Saved after every batch. Roadmap M2-09. */
export interface Cursor {
  lastLedger: bigint;
  lastEventId: string | null;
}
