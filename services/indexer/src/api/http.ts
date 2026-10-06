/** Shared request/response helpers for the list API routes. */
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { readCursorRow } from "../ingest/cursor.js";
import type { IndexerMeta } from "./schemas.js";

export interface ApiDeps {
  db: Db;
  /** Chain tip from RPC, for lag. */
  latestLedger: () => Promise<number>;
  /** /health reports "lagging" (503) beyond this many ledgers. */
  maxLagLedgers: number;
}

/** Parse request input with Zod; on failure send 400 and return undefined. */
export function parseOr400<S extends z.ZodType>(
  schema: S,
  input: unknown,
  reply: FastifyReply,
): z.infer<S> | undefined {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  reply.code(400).send({
    error: "bad_request",
    issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  return undefined;
}

export async function indexerMeta(db: Db): Promise<IndexerMeta> {
  const cursor = await readCursorRow(db);
  return { source: "indexer", indexedLedger: cursor ? Number(cursor.lastLedger) : null };
}
