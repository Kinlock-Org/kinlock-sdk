import { defineConfig } from "drizzle-kit";

// Migrations are forward-only and reviewed. Never edit an applied migration.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
