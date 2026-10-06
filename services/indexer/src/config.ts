/** Zod-validated environment. Fails fast on bad config. */
import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** Comma-separated; at least two providers in deployed environments. */
  STELLAR_RPC_URLS: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  KINLOCK_CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/),
  /** Ledger the contract was deployed in; where ingestion starts when no cursor is stored. */
  KINLOCK_START_LEDGER: z.coerce.number().int().positive(),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  /** /health reports lagging beyond this many ledgers (about 5-6 s each on Stellar). */
  MAX_LAG_LEDGERS: z.coerce.number().int().positive().default(60),
  /** A checkout of kinlock-registry (or its fixtures/ for testnet). Unset: no registry join. */
  REGISTRY_DIR: z.string().min(1).optional(),
  REGISTRY_SYNC_MS: z.coerce.number().int().positive().default(60_000),
  PORT: z.coerce.number().int().positive().default(3001),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
