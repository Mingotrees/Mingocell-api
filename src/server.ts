import { createApp } from "./app.js";
import { pool } from "./database/pool.js";
import { authOptions, createSessionStore, validateProxyBinding } from "./auth/middleware.js";

const PORT = Number(process.env.PORT ?? 20282);
const HOST = process.env.HOST ?? "127.0.0.1";
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SHUTDOWN_GRACE_MS = 10_000;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const store = createSessionStore(pool);
const authConfig = authOptions(pool, store);
validateProxyBinding(HOST, authConfig);
const app = createApp(() => pool.query("SELECT 1"), authConfig);

const server = app.listen(PORT, HOST, () => {
  console.log(`MingoCell API listening on ${HOST}:${PORT}`);
});

server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

for (const signal of SHUTDOWN_SIGNALS) {
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    deadline.unref();

    server.close(async (error) => {
      let exitCode = error ? 1 : 0;
      try {
        store.close();
        await pool.end();
      } catch {
        console.error("Failed to close PostgreSQL connections.");
        exitCode = 1;
      }
      clearTimeout(deadline);
      process.exit(exitCode);
    });
  });
}