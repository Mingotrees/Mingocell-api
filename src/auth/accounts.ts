import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword, normalizeEmail } from "./passwords.js";
import type { Role } from "./middleware.js";

export async function createAccount(pool: Pool, email: string, password: string, role: Role) {
  email = normalizeEmail(email);
  if (!["pathologist", "admin"].includes(role)) throw new Error("Invalid role.");
  const hash = await hashPassword(password);
  await pool.query(`INSERT INTO mingocell_auth.users (id, email, password_hash, role)
    VALUES ($1, $2, $3, $4)`, [randomUUID(), email, hash, role]);
}

export async function updateAccount(pool: Pool, email: string, action: "reset-password" | "deactivate", password?: string) {
  email = normalizeEmail(email);
  const hash = action === "reset-password" ? await hashPassword(password ?? "") : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`UPDATE mingocell_auth.users
      SET password_hash = COALESCE($2, password_hash),
          active = CASE WHEN $3 = 'deactivate' THEN false ELSE active END,
          auth_version = auth_version + 1
      WHERE email = $1 RETURNING id`, [email, hash, action]);
    if (!result.rows.length) throw new Error("Account not found.");
    await client.query("DELETE FROM mingocell_auth.sessions WHERE sess->'auth'->>'userId' = $1", [result.rows[0].id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
