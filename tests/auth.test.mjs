import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createApp } from "../dist/app.js";
import { createSessionStore, requireRole } from "../dist/auth/middleware.js";
import { createAccount, updateAccount } from "../dist/auth/accounts.js";
import { migrate } from "../dist/database/migration-runner.js";
import { hashPassword, normalizeEmail, verifyPassword } from "../dist/auth/passwords.js";

test("email normalization and salted password verification", async () => {
  assert.equal(normalizeEmail("  Expert@Example.org "), "expert@example.org");
  assert.throws(() => normalizeEmail("not-an-email"));
  await assert.rejects(hashPassword("short"));
  const password = "A valid test password 123!";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword(password, "malformed"), false);
});

test("pathologist permission excludes admin and anonymous users", () => {
  const guard = requireRole("pathologist");
  for (const [user, status] of [[undefined, 401], [{ role: "admin" }, 403], [{ role: "pathologist" }, undefined]]) {
    let called = false;
    guard({}, { locals: { user } }, (error) => {
      called = true;
      assert.equal(error?.status, status);
    });
    assert.equal(called, true);
  }
});

test("PostgreSQL-backed authentication lifecycle", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(url.pathname, "/mingocell_test", "Integration tests require isolated mingocell_test database");
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5, connectionTimeoutMillis: 5000 });
  t.after(() => pool.end());
  await migrate(pool);
  await migrate(pool); // Re-running migrations must preserve existing schema/data.
  const migrations = await pool.query("SELECT count(*)::int AS count FROM public.mingocell_migrations");
  assert.equal(migrations.rows[0].count, 1);

  const origin = "http://localhost:3000";
  const secret = "isolated-test-session-secret-32-characters";
  async function start(secureCookies = false) {
    const store = createSessionStore(pool);
    const app = createApp(() => pool.query("SELECT 1"), { pool, store, secret, secureCookies, origins: [origin] });
    const server = app.listen(0, "127.0.0.1");
    t.after(async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    });
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  const base = await start();
  const email = `${randomUUID()}@example.org`;
  const password = "Test-only secure password 123!";
  await createAccount(pool, email.toUpperCase(), password, "pathologist");
  await assert.rejects(createAccount(pool, email, password, "pathologist"), { code: "23505" });

  function browser(host = base, secure = false) {
    return {
      cookie: "", csrf: "",
      async request(path, { method = "GET", body, csrf = true, requestOrigin = origin, raw } = {}) {
        const headers = { Origin: requestOrigin };
        if (this.cookie) headers.Cookie = this.cookie;
        if (csrf && this.csrf) headers["X-CSRF-Token"] = this.csrf;
        if (secure) headers["X-Forwarded-Proto"] = "https";
        if (body !== undefined || raw !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetch(`${host}${path}`, {
          method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) this.cookie = setCookie.split(";")[0];
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        if (data?.csrfToken) this.csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      },
      async login(rememberMe = false, loginPassword = password) {
        await this.request("/api/v1/auth/session");
        return this.request("/api/v1/auth/login", { method: "POST", body: { email, password: loginPassword, rememberMe } });
      },
    };
  }

  await t.test("anonymous bootstrap, CORS, CSRF, input validation and no signup", async () => {
    const client = browser();
    const bootstrap = await client.request("/api/v1/auth/session");
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.data.user, null);
    assert.match(bootstrap.data.csrfToken, /^[a-f0-9]{64}$/);
    assert.equal(bootstrap.headers.get("access-control-allow-origin"), origin);
    assert.equal(bootstrap.headers.get("access-control-allow-credentials"), "true");
    assert.equal(bootstrap.headers.get("cache-control"), "no-store");
    assert.match(bootstrap.headers.get("set-cookie"), /HttpOnly/);
    assert.match(bootstrap.headers.get("set-cookie"), /SameSite=Lax/);
    assert.equal((await client.request("/api/v1/auth/login", {
      method: "POST", body: { email, password }, csrf: false,
    })).status, 403);
    assert.equal((await client.request("/api/v1/auth/login", {
      method: "POST", body: { email, password }, requestOrigin: "https://evil.example",
    })).status, 403);
    assert.equal((await client.request("/api/v1/auth/login", {
      method: "POST", body: { email, password, rememberMe: "yes" },
    })).status, 400);
    assert.equal((await client.request("/api/v1/auth/login", { method: "POST", raw: "{" })).status, 400);
    assert.equal((await client.request("/api/v1/auth/logout", { method: "POST" })).status, 401);
    assert.equal((await client.request("/api/v1/auth/signup", { method: "POST", body: {} })).status, 404);
    const wrong = await client.login(false, "wrong password");
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.data, { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
    const unknown = await client.request("/api/v1/auth/login", {
      method: "POST", body: { email: "unknown@example.org", password },
    });
    assert.deepEqual(unknown.data, wrong.data);
  });

  let weekBrowser;
  let weekSession;
  await t.test("session rotation, fixed 8-hour/7-day expiry, and current-browser logout", async () => {
    const normal = browser();
    await normal.request("/api/v1/auth/session");
    const oldCookie = normal.cookie;
    const oldToken = normal.csrf;
    const startTime = Date.now();
    const login = await normal.login();
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, "pathologist");
    assert.equal(login.data.user.email, email);
    assert.equal(login.data.user.password_hash, undefined);
    assert.notEqual(normal.cookie, oldCookie);
    assert.notEqual(normal.csrf, oldToken);
    assert.ok(Math.abs(Date.parse(login.data.expiresAt) - startTime - 8 * 3600_000) < 5000);
    const authenticatedCookie = normal.cookie;
    const sessionAgain = await normal.request("/api/v1/auth/session");
    assert.equal(sessionAgain.data.expiresAt, login.data.expiresAt);

    // A second app instance with the same database/secret simulates process restart.
    const restarted = browser(await start());
    restarted.cookie = authenticatedCookie;
    assert.equal((await restarted.request("/api/v1/auth/session")).data.user.id, login.data.user.id);
    const fixedCookie = browser();
    fixedCookie.cookie = oldCookie;
    assert.equal((await fixedCookie.request("/api/v1/auth/session")).data.user, null);

    weekBrowser = browser();
    const weekStart = Date.now();
    weekSession = await weekBrowser.login(true);
    assert.equal(weekSession.status, 200);
    assert.ok(Math.abs(Date.parse(weekSession.data.expiresAt) - weekStart - 7 * 24 * 3600_000) < 5000);
    assert.equal(weekSession.data.rememberMe, true);
    assert.match(weekSession.headers.get("set-cookie"), /Expires=/);
    assert.equal((await normal.request("/api/v1/auth/logout", { method: "POST" })).status, 204);
    assert.equal((await normal.request("/api/v1/auth/session")).data.user, null);
    assert.equal((await weekBrowser.request("/api/v1/auth/session")).data.user.id, weekSession.data.user.id);
  });

  await t.test("server enforces expiry, password reset and deactivation", async () => {
    await pool.query(`UPDATE mingocell_auth.sessions SET sess = jsonb_set(sess::jsonb,
      '{auth,expiresAt}', to_jsonb($1::bigint))::json WHERE sess->'auth'->>'userId' = $2`,
      [Date.now() - 1000, weekSession.data.user.id]);
    assert.equal((await weekBrowser.request("/api/v1/auth/session")).data.user, null);
    assert.equal((await weekBrowser.login()).status, 200);
    const saved = await pool.query("SELECT sid, sess, expire FROM mingocell_auth.sessions WHERE sess->'auth'->>'userId' = $1",
      [weekSession.data.user.id]);
    await updateAccount(pool, email, "reset-password", "Changed test password 123!");
    // Simulate an old-version login saving its session after reset deleted sessions.
    const stale = saved.rows[0];
    await pool.query("INSERT INTO mingocell_auth.sessions (sid, sess, expire) VALUES ($1, $2, $3)",
      [stale.sid, JSON.stringify(stale.sess), stale.expire]);
    assert.equal((await weekBrowser.request("/api/v1/auth/session")).data.user, null);
    assert.equal((await weekBrowser.login(false, "Changed test password 123!")).status, 200);
    await updateAccount(pool, email, "deactivate");
    assert.equal((await weekBrowser.request("/api/v1/auth/session")).data.user, null);
    assert.equal((await weekBrowser.login(false, "Changed test password 123!")).status, 401);
  });

  await t.test("production cookie is secure and host-only behind trusted proxy", async () => {
    const client = browser(await start(true), true);
    const response = await client.request("/api/v1/auth/session");
    assert.match(response.headers.get("set-cookie"), /^__Host-mingocell\.sid=/);
    assert.match(response.headers.get("set-cookie"), /; Secure/);
    assert.doesNotMatch(response.headers.get("set-cookie"), /Domain=/i);
  });

  await t.test("login attempts are throttled", async () => {
    const client = browser();
    let response;
    for (let attempt = 0; attempt < 12; attempt++) {
      response = await client.login(false, "wrong password");
      if (response.status === 429) break;
    }
    assert.equal(response.status, 429);
    assert.equal(response.data.error.code, "RATE_LIMITED");
  });
});
