import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { pool } from "../database/pool.js";
import { createAccount, updateAccount } from "../auth/accounts.js";
import { normalizeEmail, validatePassword } from "../auth/passwords.js";
import type { Role } from "../auth/middleware.js";

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Password entry requires an interactive terminal.");
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(prompt);
  try {
    return await new Promise((resolve, reject) => {
      rl.once("SIGINT", () => reject(new Error("Cancelled.")));
      rl.once("close", () => reject(new Error("Password input closed.")));
      rl.question("", resolve);
    });
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

try {
  const [action, inputEmail, inputRole = "pathologist", ...extra] = process.argv.slice(2);
  if (!inputEmail || extra.length || !["create", "reset-password", "deactivate"].includes(action ?? "")) {
    throw new Error("Usage: npm run account -- create EMAIL [pathologist|admin] | reset-password EMAIL | deactivate EMAIL");
  }
  const email = normalizeEmail(inputEmail);
  if (!["pathologist", "admin"].includes(inputRole)) throw new Error("Invalid role.");
  if (action === "deactivate") {
    await updateAccount(pool, email, "deactivate");
  } else {
    const password = await hiddenPassword("Password (12–128 characters): ");
    validatePassword(password);
    if (password !== await hiddenPassword("Confirm password: ")) throw new Error("Passwords do not match.");
    if (action === "create") await createAccount(pool, email, password, inputRole as Role);
    else await updateAccount(pool, email, "reset-password", password);
  }
  console.log("Account operation completed.");
} catch (error) {
  // Database errors may contain identifying data; report only safe validation messages.
  if (error instanceof Error && !("code" in error)) console.error(error.message);
  else console.error("Account operation failed. Check existing account and database access.");
  process.exitCode = 1;
} finally { await pool.end(); }
