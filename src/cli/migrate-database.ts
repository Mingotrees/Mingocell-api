import { pool } from "../database/pool.js";
import { migrate } from "../database/migration-runner.js";

try {
  await migrate(pool);
} catch {
  console.error("Database migration failed. Check connectivity, schema permissions, and migration history.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
