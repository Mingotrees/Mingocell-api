import { createApp } from "./app.js";
import { pool } from "./database/pool.js";
import { authOptions, createSessionStore, validateProxyBinding } from "./auth/middleware.js";

const port = Number(process.env.PORT ?? 20282);
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const store = createSessionStore(pool);
const authentication = authOptions(pool, store);
validateProxyBinding(host, authentication);
const app = createApp(() => pool.query("SELECT 1"), authentication);

const server = app.listen(port, host, () => {
  console.log(`MingoCell API listening on ${host}:${port}`);
});

server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();

    server.close(async (error) => {
      let exitCode = error ? 1 : 0;

      try {
        store.close();
        await pool.end();
      } catch {
        console.error("Failed to close PostgresSQL connections.");
        exitCode = 1;
      }

      clearTimeout(timeout);
      process.exit(exitCode);
    });
  });
}
