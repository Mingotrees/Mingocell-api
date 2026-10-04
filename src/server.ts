import { createApp } from "./app.js";
import { pool } from "./database/pool.js";
import { authOptions, createSessionStore, validateProxyBinding } from "./auth/middleware.js";
import { logger, safeErrorType } from "./logging.js";

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
  logger("info", "server.started", { host: HOST, port: PORT, environment: process.env.NODE_ENV ?? "production" });
});

server.on("error", (error) => {
  logger("error", "server.listen.failed", { errorType: safeErrorType(error) });
  process.exit(1);
});

for (const signal of SHUTDOWN_SIGNALS) {
  process.once(signal, () => {
    logger("info", "server.shutdown.started", { signal });
    const deadline = setTimeout(() => {
      logger("error", "server.shutdown.timed_out", { timeoutMs: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();

    server.close(async (error) => {
      let exitCode = error ? 1 : 0;
      try {
        store.close();
        await pool.end();
      } catch {
        logger("error", "database.shutdown.failed");
        exitCode = 1;
      }
      clearTimeout(deadline);
      logger(exitCode ? "error" : "info", "server.shutdown.completed", { exitCode });
      process.exit(exitCode);
    });
  });
}
