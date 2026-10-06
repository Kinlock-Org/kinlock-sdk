/** Database handle shared by node-postgres (service) and PGlite (tests). */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: url });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
