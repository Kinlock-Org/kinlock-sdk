/**
 * Polls getEvents from the persisted cursor, writes idempotently on (tx_hash, event_index),
 * and STOPS with an alert on any gap. Never skips a gap silently. Roadmap M2-09.
 */
export {};
