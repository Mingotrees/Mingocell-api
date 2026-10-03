import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { pool } from "../database/pool.js";
import { createAccount, updateAccount } from "../auth/accounts.js";
import { normalizeEmail, validatePassword } from "../auth/passwords.js";
import type { Role } from "../auth/middleware.js";

const ROLES: Role[] = ["pathologist", "admin"];
const USAGE =
  "Usage: npm run account -- create EMAIL [pathologist|admin] | reset-password EMAIL | deactivate EMAIL";

async function run(action: string | undefined, emailInput: string | undefined, roleInput: string, extra: string[]) {
  if (!action || !emailInput || extra.length || !["create", "reset-password", "deactivate"].includes(action)) {
    throw new Error(USAGE);
  }
  const email = normalizeEmail(emailInput);
  if (!ROLES.includes(roleInput as Role)) throw new Error("Invalid role.");

  if (action === "deactivate") return updateAccount(pool, email, "deactivate");

  const password = await promptPassword("Password (12–128 characters): ");
  validatePassword(password);
  if (password !== await promptPassword("Confirm password: ")) throw new Error("Passwords do not match.");

  if (action === "create") return createAccount(pool, email, password, roleInput as Role);
  return updateAccount(pool, email, "reset-password", password);
}

async function promptPassword(prompt: string) {
  if (!process.stdin.isTTY) throw new Error("Password entry requires an interactive terminal.");
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  process.stdout.write(prompt);
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once("SIGINT", () => reject(new Error("Cancelled.")));
      rl.once("close", () => reject(new Error("Password input closed.")));
      rl.question("", resolve);
    });
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

const [, , action, email, role = "pathologist", ...extra] = process.argv;
try {
  await run(action, email, role, extra);
  console.log("Account operation completed.");
} catch (error) {
  // Database errors may contain identifying data; report only safe validation messages.
  if (error instanceof Error && !("code" in error)) console.error(error.message);
  else console.error("Account operation failed. Check existing account and database access.");
  process.exitCode = 1;
} finally {
  await pool.end();
}