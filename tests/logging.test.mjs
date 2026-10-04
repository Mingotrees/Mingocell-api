import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { createLogger, safeErrorType } from "../dist/logging.js";

test("structured logger emits stable JSON and removes sensitive fields", () => {
  const lines = [];
  const log = createLogger(
    (line, level) => lines.push({ line, level }),
    () => new Date("2026-10-04T09:30:00.000Z"),
  );

  log("info", "test.completed", {
    requestId: "request-123",
    status: 204,
    password: "password-secret",
    csrfToken: "csrf-secret",
    userEmail: "private@example.org",
    cookieHeader: "cookie-secret",
    timestamp: "caller-cannot-replace-timestamp",
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "info");
  assert.deepEqual(JSON.parse(lines[0].line), {
    timestamp: "2026-10-04T09:30:00.000Z",
    service: "mingocell-api",
    level: "info",
    event: "test.completed",
    requestId: "request-123",
    status: 204,
  });
  assert.doesNotMatch(lines[0].line, /password-secret|csrf-secret|private@example|cookie-secret|caller-cannot/);
  const unsafeError = new Error("message-secret");
  unsafeError.name = "CustomError-with-secret";
  assert.equal(safeErrorType(unsafeError), "Error");
  assert.equal(safeErrorType(new TypeError("safe type")), "TypeError");
  assert.equal(safeErrorType("non-error-secret"), "NonError");
});

test("request logs correlate safely without URL, body, header, or error details", async (t) => {
  const entries = [];
  const log = createLogger((line, level) => entries.push({ ...JSON.parse(line), sinkLevel: level }));
  const databaseSecret = "database-password=never-log-this";
  const app = createApp(async () => {
    throw new Error(databaseSecret);
  }, undefined, log);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  const missing = await fetch(`${base}/private@example.org?token=query-secret`, {
    method: "POST",
    headers: {
      Authorization: "Bearer authorization-secret",
      Cookie: "session=cookie-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "body@example.org", password: "body-secret" }),
  });
  assert.equal(missing.status, 404);
  const missingRequestId = missing.headers.get("x-request-id");

  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 503);
  const readyRequestId = ready.headers.get("x-request-id");

  const missingLog = entries.find((entry) => entry.event === "http.request.completed"
    && entry.requestId === missingRequestId);
  assert.deepEqual({
    level: missingLog.level,
    method: missingLog.method,
    route: missingLog.route,
    status: missingLog.status,
  }, { level: "info", method: "POST", route: "unmatched", status: 404 });
  assert.equal(typeof missingLog.durationMs, "number");

  assert.ok(entries.some((entry) => entry.event === "database.readiness.failed"
    && entry.requestId === readyRequestId && entry.sinkLevel === "error"));
  assert.ok(entries.some((entry) => entry.event === "http.request.completed"
    && entry.requestId === readyRequestId && entry.route === "/health/ready" && entry.status === 503));

  const output = JSON.stringify(entries);
  assert.doesNotMatch(output, /private@example|query-secret|authorization-secret|cookie-secret/);
  assert.doesNotMatch(output, /body@example|body-secret|database-password|never-log-this/);
});
