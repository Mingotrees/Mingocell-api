import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { withTransaction } from "./transaction.js";

const MIGRATION_FILE = /^\d+_[a-z0-9_]+\.sql$/;
const MIGRATIONS_DIRECTORY = new URL("../../migrations/", import.meta.url);

async function applyPending(client: import("pg").PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('mingocell-api:migrations'))");
  await client.query(`CREATE TABLE IF NOT EXISTS public.mingocell_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(MIGRATIONS_DIRECTORY)).filter((file) => MIGRATION_FILE.test(file)).sort();
  for (const file of files) {
    const sql = await readFile(new URL(file, MIGRATIONS_DIRECTORY), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = await client.query("SELECT checksum FROM public.mingocell_migrations WHERE name = $1", [file]);

    if (applied.rows.length) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${file}`);
      continue;
    }

    await client.query(sql);
    await client.query("INSERT INTO public.mingocell_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
    console.log(`Applied migration ${file}`);
  }
}

export async function migrate(pool: Pool) {
  await withTransaction(pool, applyPending);
}