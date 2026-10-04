import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";

const noOpLogger = () => {};

test("health and unknown routes return documented JSON", async (t) => {
  const app = createApp(async () => ({ rows: [{ value: 1 }] }), undefined, noOpLogger);
  const server = app.listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/health/live`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "mingocell-api",
  });
  assert.equal(health.headers.get("x-powered-by"), null);

  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    error: { code: "NOT_FOUND", message: "Route not found." },
  });
});

test("database failure returns 503 while liveness stays healthy", async (t) => {
  const app = createApp(async () => {
    throw new Error("Internal database details must not reach client");
  }, undefined, noOpLogger);

  const server = app.listen(0, "127.0.0.1");

  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    status: "unavailable",
    error: {
      code: "DATABASE_UNAVAILABLE",
      message: "Database connection unavailable.",
    },
  });

  const live = await fetch(`${base}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), {
    status: "ok",
    service: "mingocell-api",
  });
});
