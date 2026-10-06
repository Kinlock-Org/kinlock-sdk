/** Applies pending forward-only migrations, then exits. Run before the service starts. */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { z } from "zod";
import { MIGRATIONS_FOLDER } from "./migrations.js";

const { DATABASE_URL } = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("migrations applied");
} finally {
  await pool.end();
}
