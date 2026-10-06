import { describe, expect, it } from "vitest";
import { decodeEvent, scvToNative } from "../src/ingest/decode.js";
import {
  createRpcClient,
  ledgerOfCursor,
  RpcError,
  RpcUnavailableError,
} from "../src/rpc/client.js";
import { fixture } from "./helpers/fixtures.js";

const page = {
  events: [],
  cursor: "0021712232207351807-4294967295",
  latestLedger: 10,
  oldestLedger: 1,
};
const ok = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });

describe("rpc client", () => {
  it("fails over to the next provider on network errors and 5xx", async () => {
    const hit: string[] = [];
    const fetchImpl = (async (url: string) => {
      hit.push(url);
      if (url === "https://a") throw new Error("ECONNREFUSED");
      if (url === "https://b") return new Response("busy", { status: 503 });
      return ok(page);
    }) as typeof fetch;
    const rpc = createRpcClient(["https://a", "https://b", "https://c"], fetchImpl);
    expect(await rpc.getEvents({ contractId: "C", startLedger: 1, limit: 1 })).toEqual(page);
    expect(hit).toEqual(["https://a", "https://b", "https://c"]);
    // It sticks with the provider that answered.
    await rpc.getEvents({ contractId: "C", cursor: "x", limit: 1 });
    expect(hit.at(-1)).toBe("https://c");
  });

  it("throws a JSON-RPC error instead of retrying elsewhere", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: -32600, message: "startLedger out of range" } }),
      );
    }) as unknown as typeof fetch;
    const rpc = createRpcClient(["https://a", "https://b"], fetchImpl);
    await expect(rpc.getEvents({ contractId: "C", startLedger: 1, limit: 1 })).rejects.toThrow(
      RpcError,
    );
    expect(calls).toBe(1);
  });

  it("reports unavailable when every provider fails", async () => {
    const fetchImpl = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const rpc = createRpcClient(["https://a", "https://b"], fetchImpl);
    await expect(rpc.getLatestLedger()).rejects.toThrow(RpcUnavailableError);
  });

  it("rejects a malformed response", async () => {
    const fetchImpl = (async () => ok({ events: "nope" })) as unknown as typeof fetch;
    const rpc = createRpcClient(["https://a"], fetchImpl);
    await expect(rpc.getEvents({ contractId: "C", startLedger: 1, limit: 1 })).rejects.toThrow();
  });

  it("reads the ledger out of a paging cursor", () => {
    expect(ledgerOfCursor("0021712232207351807-4294967295")).toBe(5055272);
    expect(ledgerOfCursor(fixture.events[0]?.id ?? "")).toBe(fixture.events[0]?.ledger);
  });
});

describe("decode", () => {
  it("turns a recorded LockCreated into typed values", () => {
    const raw = fixture.events.find((x) => x.id === "0021711785530793984-0000000001");
    if (!raw) throw new Error("fixture missing");
    const e = decodeEvent(raw);
    expect(e).toMatchObject({ type: "LockCreated", schemaVersion: 1, eventIndex: 1, key: 1n });
    expect(e.payload.total).toBe(100000000n);
    expect(e.payload.tranche_count).toBe(2);
  });

  it("decodes enums, bytes and void", () => {
    expect(scvToNative({ vec: [{ symbol: "Rent" }] })).toEqual(["Rent"]);
    expect(scvToNative({ bytes: "00ff" })).toBe("00ff");
    expect(scvToNative("void")).toBeNull();
  });
});
