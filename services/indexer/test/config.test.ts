import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgres://kinlock:kinlock@localhost:5432/kinlock",
  STELLAR_RPC_URLS: "https://rpc-a.example, https://rpc-b.example",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  KINLOCK_CONTRACT_ID: "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
  KINLOCK_START_LEDGER: "5052300",
};

describe("loadConfig", () => {
  it("parses a valid environment and splits the RPC list", () => {
    const config = loadConfig(valid);
    expect(config.STELLAR_RPC_URLS).toEqual(["https://rpc-a.example", "https://rpc-b.example"]);
    expect(config.PORT).toBe(3001);
  });

  it("refuses a missing database URL", () => {
    const { DATABASE_URL: _, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow();
  });

  it("refuses a contract id that isn't a C… address", () => {
    expect(() => loadConfig({ ...valid, KINLOCK_CONTRACT_ID: "GABC" })).toThrow();
  });
});
