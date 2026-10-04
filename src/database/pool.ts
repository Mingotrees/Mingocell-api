import { Pool } from "pg";
import { logger } from "../logging.js";

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

const port = Number(required("DB_PORT"));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("DB_PORT must be an integer between 1 and 65535");
}

export const pool = new Pool({
  host: required("DB_HOST"),
  port,
  database: required("DB_NAME"),
  user: required("DB_USER"),
  password: required("DB_PASSWORD"),
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
});

pool.on("error", () => {
  logger("error", "database.idle_connection.failed");
});
