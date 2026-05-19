import { createRequire } from "module";
import { defineConfig } from "prisma/config";

// Best-effort dotenv load. Local dev reads .env; production runtimes (Railway)
// inject env vars directly and don't include dotenv in the standalone runtime
// trace, so we swallow the missing-module error and continue.
const requireOptional = createRequire(import.meta.url);
try {
  requireOptional("dotenv/config");
} catch {
  // dotenv not available — env vars already in process.env
}

const dbUrl = process.env.DATABASE_PATH
  ? `file:${process.env.DATABASE_PATH}`
  : (process.env.DATABASE_URL || "file:./dev.db");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: dbUrl,
  },
});
