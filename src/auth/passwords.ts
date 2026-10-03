import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import validator from "validator";

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !validator.isEmail(email)) throw new Error("Invalid email address.");
  return email;
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new Error("Password must contain between 12 and 128 characters.");
  }
}

async function derive(password: string, salt: string): Promise<Buffer> {
  // Fixed scrypt parameters: N=32768, r=8, p=3 (roughly 32 MiB per operation).
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [version, salt, digest] = hash.split("$");
  if (version !== "scrypt-v1" || !/^[a-f0-9]{32}$/.test(salt ?? "") ||
      !/^[a-f0-9]{128}$/.test(digest ?? "")) return false;
  return timingSafeEqual(await derive(password, salt!), Buffer.from(digest!, "hex"));
}
