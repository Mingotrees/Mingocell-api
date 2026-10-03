import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword, normalizeEmail } from "./passwords.js";
import { withTransaction } from "../database/transaction.js";
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
  await withTransaction(pool, async (client) => {
    const result = await client.query(`UPDATE mingocell_auth.users
      SET password_hash = COALESCE($2, password_hash),
          active = CASE WHEN $3 = 'deactivate' THEN false ELSE active END,
          auth_version = auth_version + 1
      WHERE email = $1 RETURNING id`, [email, hash, action]);
    if (!result.rows.length) throw new Error("Account not found.");
    await revokeSessions(client, result.rows[0].id);
  });
}

// Any password change or deactivation must drop every stored session, including
// one an in-flight login writes after this statement commits.
async function revokeSessions(client: import("pg").PoolClient, userId: string) {
  await client.query("DELETE FROM mingocell_auth.sessions WHERE sess->'auth'->>'userId' = $1", [userId]);
}