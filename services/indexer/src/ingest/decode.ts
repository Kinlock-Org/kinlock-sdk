/**
 * Turns an RPC event (xdrFormat=json) into a typed, plain-value event. Roadmap M2-10.
 * Unknown event names or malformed payloads throw: the indexer stops rather than skip.
 */
import type { DecodedEvent, EventType, Native } from "../handlers/types.js";
import type { RpcEvent } from "../rpc/client.js";

/** Contract event names (snake_case topic) to indexer event types. */
const EVENT_NAMES: Record<string, EventType> = {
  payee_registered: "PayeeRegistered",
  payee_status_changed: "PayeeStatusChanged",
  payout_updated: "PayoutUpdated",
  lock_created: "LockCreated",
  released: "Released",
  refunded: "Refunded",
  declined: "Declined",
};

export class DecodeError extends Error {
  override name = "DecodeError";
}

/** One JSON-encoded ScVal to a plain value. 64/128-bit integers become bigint; bytes become hex. */
export function scvToNative(v: unknown): Native {
  if (v === "void" || v === null) return null;
  if (typeof v !== "object") throw new DecodeError(`unexpected ScVal: ${JSON.stringify(v)}`);
  const [kind, value] = Object.entries(v as Record<string, unknown>)[0] ?? [];
  switch (kind) {
    case "symbol":
    case "string":
    case "address":
    case "bytes":
      return String(value);
    case "bool":
      return Boolean(value);
    case "u32":
    case "i32":
      return Number(value);
    case "u64":
    case "i64":
    case "u128":
    case "i128":
      return BigInt(String(value));
    case "vec":
      return (value as unknown[]).map(scvToNative);
    case "map":
      return Object.fromEntries(
        (value as { key: unknown; val: unknown }[]).map(({ key, val }) => [
          String(scvToNative(key)),
          scvToNative(val),
        ]),
      );
    default:
      throw new DecodeError(`unsupported ScVal kind: ${kind}`);
  }
}

export function decodeEvent(raw: RpcEvent): DecodedEvent {
  const [nameTopic, keyTopic] = raw.topicJson;
  const name = String(scvToNative(nameTopic));
  const type = EVENT_NAMES[name];
  if (!type) throw new DecodeError(`unknown event "${name}" in ${raw.txHash}`);
  const payload = scvToNative(raw.valueJson);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DecodeError(`event ${raw.id} has no field map`);
  }
  const schemaVersion = payload.schema_version;
  if (typeof schemaVersion !== "number") {
    throw new DecodeError(`event ${raw.id} has no schema_version`);
  }
  const eventIndex = Number.parseInt(raw.id.split("-")[1] ?? "", 10);
  if (!Number.isInteger(eventIndex)) throw new DecodeError(`bad event id ${raw.id}`);
  return {
    type,
    schemaVersion,
    txHash: raw.txHash,
    eventIndex,
    id: raw.id,
    ledger: raw.ledger,
    ledgerTime: new Date(raw.ledgerClosedAt),
    key: keyTopic === undefined ? null : scvToNative(keyTopic),
    payload: payload as Record<string, Native>,
  };
}
