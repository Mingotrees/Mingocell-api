import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { app } from "../dist/app.js";

test("health and unknown routes return documented JSON", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/health/live`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok", service: "mingocell-api",
  });
  assert.equal(health.headers.get("x-powered-by"), null);

  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    error: { code: "NOT_FOUND", message: "Route not found." },
  });
});
