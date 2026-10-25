import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import sharp from "sharp";
import { createApp } from "../dist/app.js";
import { createSessionStore, requireRole, validateProxyBinding } from "../dist/auth/middleware.js";
import { createAccount, updateAccount } from "../dist/auth/accounts.js";
import { migrate } from "../dist/database/migration-runner.js";
import { hashPassword, normalizeEmail, verifyPassword } from "../dist/auth/passwords.js";
import { imageStorageOptions, initializeImageStorage } from "../dist/images/storage.js";
import { analysisTests } from './analysis-integration.mjs';

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
  assert.throws(
    () => validateProxyBinding("0.0.0.0", { trustLocalHttpsProxy: true }),
    /requires HOST=127\.0\.0\.1/,
  );
  assert.doesNotThrow(() => validateProxyBinding("127.0.0.1", { trustLocalHttpsProxy: true }));
});

test("explicit multi-role permission admits admins and pathologists only", () => {
  const guard = requireRole("pathologist", "admin");
  for (const [user, status] of [
    [undefined, 401],
    [{ role: "admin" }, undefined],
    [{ role: "pathologist" }, undefined],
    [{ role: "unsupported" }, 403],
  ]) {
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
  // Reproduce production state: migration 001 is already recorded with its
  // deployed checksum, so later migrations may run.
  const firstSql = await readFile(new URL("../migrations/001_auth.sql", import.meta.url), "utf8");
  const firstChecksum = createHash("sha256").update(firstSql).digest("hex");
  assert.equal(firstChecksum, "e30a8ff9581408593ed715bb3f2bb9bc7740f77001137c284db95dc95d80b6ea");
  await pool.query(`CREATE TABLE public.mingocell_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(firstSql);
  await pool.query("INSERT INTO public.mingocell_migrations (name, checksum) VALUES ($1, $2)",
    ["001_auth.sql", firstChecksum]);
  const existingUser = randomUUID();
  await pool.query(`INSERT INTO mingocell_auth.users (id, email, password_hash, role)
    VALUES ($1, $2, 'deployed-test-hash', 'admin')`, [existingUser, `${existingUser}@example.org`]);
  await migrate(pool);
  await migrate(pool); // Re-running migrations must preserve existing schema/data.
  const migrations = await pool.query("SELECT count(*)::int AS count FROM public.mingocell_migrations");
  assert.equal(migrations.rows[0].count, 5);
  const keptUser = await pool.query("SELECT role FROM mingocell_auth.users WHERE id = $1", [existingUser]);
  assert.equal(keptUser.rows[0].role, "admin");
  await assert.rejects(pool.query("UPDATE mingocell_auth.users SET role = 'maintainer' WHERE id = $1",
    [existingUser]), /users_role_check/);

  const origin = "http://localhost:3000";
  const secret = "isolated-test-session-secret-32-characters";
  const requestLogs = [];
  const captureLogger = (level, event, fields = {}) => requestLogs.push({ level, event, ...fields });
  const storageRoot = await mkdtemp(join(tmpdir(), "mingocell-images-"));
  const imageStorage = imageStorageOptions(pool, { IMAGE_STORAGE_ROOT: storageRoot });
  await initializeImageStorage(imageStorage);
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  async function start({ secureCookies = false, trustLocalHttpsProxy = false } = {}) {
    const store = createSessionStore(pool);
    const app = createApp(() => pool.query("SELECT 1"), {
      pool, store, secret, secureCookies, trustLocalHttpsProxy, origins: [origin],
    }, captureLogger, imageStorage);
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

  function browser(host = base) {
    return {
      cookie: "", csrf: "",
      async request(path, { method = "GET", body, csrf = true, requestOrigin = origin, raw, form, extraHeaders = {} } = {}) {
        const headers = { Origin: requestOrigin, ...extraHeaders };
        if (this.cookie) headers.Cookie = this.cookie;
        if (csrf && this.csrf) headers["X-CSRF-Token"] = this.csrf;
        if (form === undefined && (body !== undefined || raw !== undefined) && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        const response = await fetch(`${host}${path}`, {
          method, headers, body: form ?? raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) this.cookie = setCookie.split(";")[0];
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        if (data?.csrfToken) this.csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      },
      async upload(bytes, key, filename = "cell.tif", type = "image/tiff") {
        const form = new FormData();
        form.set("image", new Blob([bytes], { type }), filename);
        const extraHeaders = key ? { "Idempotency-Key": key } : {};
        return this.request("/api/v1/submissions", { method: "POST", form, extraHeaders });
      },
      raw(path) {
        return fetch(`${host}${path}`, { headers: { Origin: origin, Cookie: this.cookie } });
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
    assert.ok(requestLogs.some((entry) => entry.event === "http.request.completed"
      && entry.route === "/api/v1/auth/login" && entry.status === 200
      && entry.actorId === login.data.user.id && entry.actorRole === "pathologist"));
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

  await t.test("private image intake validates, expands TIFF pages and replays safely", async () => {
    const singlePage = await sharp({
      create: { width: 288, height: 288, channels: 3, background: "#6d2332" },
    }).tiff().toBuffer();
    const key = randomUUID();
    const uploaded = await weekBrowser.upload(singlePage, key);
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.data.image.format, "tiff");
    assert.equal(uploaded.data.image.originalFilename, "cell.tif");
    assert.equal(uploaded.data.submissions[0].displayName, "cell.tif");
    assert.equal(uploaded.data.image.pageCount, 1);
    assert.equal(uploaded.data.submissions.length, 1);
    assert.equal(uploaded.data.submissions[0].width, 288);
    assert.equal(uploaded.data.submissions[0].height, 288);

    const replayed = await weekBrowser.upload(singlePage, key, "renamed.tif");
    assert.equal(replayed.status, 201);
    assert.equal(replayed.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(replayed.data, uploaded.data);
    const imageRows = await pool.query("SELECT count(*)::int AS count FROM mingocell_data.images WHERE owner_id = $1",
      [weekSession.data.user.id]);
    assert.equal(imageRows.rows[0].count, 1);

    const submissionId = uploaded.data.submissions[0].id;
    const detail = await weekBrowser.request(`/api/v1/submissions/${submissionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.status, "uploaded");
    assert.equal(detail.data.source.originalFilename, "cell.tif");
    assert.equal(detail.data.displayName, "cell.tif");
    await pool.query("UPDATE mingocell_data.images SET original_filename = NULL WHERE id = $1", [uploaded.data.image.id]);
    const legacy = await weekBrowser.request(`/api/v1/submissions/${submissionId}`);
    assert.equal(legacy.data.source.originalFilename, null);
    assert.equal(legacy.data.displayName, `Submission ${submissionId}`);
    const original = await weekBrowser.raw(`/api/v1/submissions/${submissionId}/image`);
    assert.equal(original.status, 200);
    assert.equal(original.headers.get("content-type"), "image/tiff");
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), singlePage);
    const preview = await weekBrowser.raw(`/api/v1/submissions/${submissionId}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/jpeg");
    assert.ok((await preview.arrayBuffer()).byteLength > 0);

    const secondEmail = `${randomUUID()}@example.org`;
    const secondPassword = "Second test password 123!";
    await createAccount(pool, secondEmail, secondPassword, "pathologist");
    const second = browser();
    await second.request("/api/v1/auth/session");
    const secondLogin = await second.request("/api/v1/auth/login", {
      method: "POST", body: { email: secondEmail, password: secondPassword, rememberMe: false },
    });
    assert.equal(secondLogin.status, 200);
    assert.equal((await second.request(`/api/v1/submissions/${submissionId}`)).status, 404);
    assert.equal((await second.raw(`/api/v1/submissions/${submissionId}/image`)).status, 404);

    const multiPage = await sharp([
      { create: { width: 288, height: 288, channels: 3, background: "#112233" } },
      { create: { width: 288, height: 288, channels: 3, background: "#ddeeff" } },
    ], { join: { animated: true } }).tiff().toBuffer();
    const multi = await weekBrowser.upload(multiPage, randomUUID());
    assert.equal(multi.status, 201);
    assert.equal(multi.data.image.pageCount, 2);
    assert.deepEqual(multi.data.submissions.map((submission) => submission.pageIndex), [0, 1]);
    assert.deepEqual(multi.data.submissions.map((submission) => submission.displayName), ["cell.tif — Page 1", "cell.tif — Page 2"]);
    assert.notEqual(multi.data.image.id, uploaded.data.image.id);
    const secondPage = await weekBrowser.request(`/api/v1/submissions/${multi.data.submissions[1].id}`);
    assert.equal(secondPage.data.displayName, "cell.tif — Page 2");
    assert.equal(secondPage.data.source.originalFilename, "cell.tif");
    const firstPreview = Buffer.from(await (await weekBrowser.raw(multi.data.submissions[0].previewUrl)).arrayBuffer());
    const secondPreview = Buffer.from(await (await weekBrowser.raw(multi.data.submissions[1].previewUrl)).arrayBuffer());
    assert.notDeepEqual((await sharp(firstPreview).stats()).dominant, (await sharp(secondPreview).stats()).dominant);

    const concurrentKey = randomUUID();
    const otherInstance = browser(await start());
    otherInstance.cookie = weekBrowser.cookie;
    otherInstance.csrf = weekBrowser.csrf;
    const concurrent = await Promise.all([
      weekBrowser.upload(singlePage, concurrentKey),
      otherInstance.upload(singlePage, concurrentKey),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status), [201, 201]);
    assert.deepEqual(concurrent[0].data, concurrent[1].data);
    assert.equal(concurrent.filter((response) => response.headers.get("idempotency-replayed") === "true").length, 1);

    const png = await sharp({
      create: { width: 64, height: 48, channels: 4, background: "#224466" },
    }).png().toBuffer();
    const pngUpload = await weekBrowser.upload(png, randomUUID(), "cell.png", "image/png");
    assert.equal(pngUpload.status, 201);
    assert.equal(pngUpload.data.image.format, "png");
    const jpeg = await sharp({
      create: { width: 48, height: 64, channels: 3, background: "#664422" },
    }).jpeg().toBuffer();
    const jpegUpload = await weekBrowser.upload(jpeg, randomUUID(), "cell.jpg", "image/jpeg");
    assert.equal(jpegUpload.status, 201);
    assert.equal(jpegUpload.data.image.format, "jpeg");

    const changedPayload = await sharp({
      create: { width: 288, height: 288, channels: 3, background: "#ffffff" },
    }).tiff().toBuffer();
    assert.equal((await weekBrowser.upload(changedPayload, key)).status, 409);
    assert.equal((await weekBrowser.upload(Buffer.from("not an image"), randomUUID())).status, 400);
    assert.equal((await weekBrowser.upload(singlePage, "")).status, 400);
    const malformed = await weekBrowser.request("/api/v1/submissions", {
      method: "POST",
      raw: "broken multipart",
      extraHeaders: { "Content-Type": "multipart/form-data", "Idempotency-Key": randomUUID() },
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.data.error.code, "INVALID_MULTIPART");
    const malformedBoundary = await weekBrowser.request("/api/v1/submissions", {
      method: "POST",
      raw: "broken multipart",
      extraHeaders: { "Content-Type": "multipart/form-data; boundary=\"bad", "Idempotency-Key": randomUUID() },
    });
    assert.equal(malformedBoundary.status, 400);
    assert.equal(malformedBoundary.data.error.code, "INVALID_MULTIPART");
    const malformedHeader = await weekBrowser.request("/api/v1/submissions", {
      method: "POST",
      raw: "--bad\r\nMalformed header\r\n\r\ndata\r\n--bad--\r\n",
      extraHeaders: { "Content-Type": "multipart/form-data; boundary=bad", "Idempotency-Key": randomUUID() },
    });
    assert.equal(malformedHeader.status, 400);
    assert.equal(malformedHeader.data.error.code, "INVALID_MULTIPART");
    const extraField = new FormData();
    extraField.set("image", new Blob([singlePage], { type: "image/tiff" }), "cell.tif");
    extraField.set("unexpected", "value");
    const extraFieldResponse = await weekBrowser.request("/api/v1/submissions", {
      method: "POST", form: extraField, extraHeaders: { "Idempotency-Key": randomUUID() },
    });
    assert.equal(extraFieldResponse.status, 400);
    assert.equal(extraFieldResponse.data.error.code, "INVALID_MULTIPART");

    const tooLargeByPixels = await sharp({
      create: { width: 2001, height: 2000, channels: 3, background: "#000000" },
    }).png().toBuffer();
    const pixelsResponse = await weekBrowser.upload(tooLargeByPixels, randomUUID(), "large.png", "image/png");
    assert.equal(pixelsResponse.status, 413);

    const tooManyTotalPixels = await sharp(Array.from({ length: 6 }, (_, index) => ({
      create: { width: 2000, height: 2000, channels: 3, background: index % 2 ? "#eeeeee" : "#111111" },
    })), { join: { animated: true } }).tiff().toBuffer();
    assert.ok(tooManyTotalPixels.byteLength < 5 * 1024 * 1024);
    assert.equal((await weekBrowser.upload(tooManyTotalPixels, randomUUID())).status, 413);

    const tooManyPages = await sharp(Array.from({ length: 21 }, (_, index) => ({
      create: { width: 8, height: 8, channels: 3, background: index % 2 ? "#ffffff" : "#000000" },
    })), { join: { animated: true } }).tiff().toBuffer();
    assert.equal((await weekBrowser.upload(tooManyPages, randomUUID())).status, 413);
    const tooManyBytes = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    assert.equal((await weekBrowser.upload(tooManyBytes, randomUUID())).status, 413);
  });

  await t.test("submission history is owner-only, filtered and stably paginated", async () => {
    assert.equal((await browser().request("/api/v1/submissions")).status, 401);
    const ownerId = weekSession.data.user.id;
    // Exercise microsecond precision and timestamp ties across multiple pages.
    await pool.query(`UPDATE mingocell_data.submissions s
      SET created_at = '2026-10-01T12:00:00.123456Z'
      FROM mingocell_data.images i WHERE i.id = s.image_id AND i.owner_id = $1`, [ownerId]);
    const expected = await pool.query(`SELECT s.id FROM mingocell_data.submissions s
      JOIN mingocell_data.images i ON i.id = s.image_id
      WHERE i.owner_id = $1 ORDER BY s.created_at DESC, s.id DESC`, [ownerId]);
    assert.ok(expected.rows.length > 2);
    const ids = [];
    let cursor = null;
    do {
      const page = await weekBrowser.request(`/api/v1/submissions?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(page.status, 200);
      assert.ok(page.data.submissions.length <= 2);
      assert.ok(page.data.submissions.every((submission) => typeof submission.displayName === "string"));
      assert.equal(page.data.pageInfo.hasMore, page.data.pageInfo.nextCursor !== null);
      ids.push(...page.data.submissions.map((submission) => submission.id));
      cursor = page.data.pageInfo.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, expected.rows.map((row) => row.id));
    await pool.query("UPDATE mingocell_data.submissions SET status = 'failed' WHERE id = $1", [ids[0]]);
    const filtered = await weekBrowser.request("/api/v1/submissions?status=failed");
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.data.submissions.map((submission) => submission.id), [ids[0]]);
    const analyzed = await weekBrowser.request("/api/v1/submissions?status=analyzed");
    assert.deepEqual(analyzed.data, { submissions: [], pageInfo: { hasMore: false, nextCursor: null } });
    const first = await weekBrowser.request("/api/v1/submissions?limit=1");
    assert.equal((await weekBrowser.request(`/api/v1/submissions?status=failed&cursor=${first.data.pageInfo.nextCursor}`)).status, 400);
    for (const query of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=2&limit=3", "status=reviewed", "cursor=garbage", "cursor="]) {
      const response = await weekBrowser.request(`/api/v1/submissions?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.data.error.code, "INVALID_INPUT");
    }
    const otherEmail = `${randomUUID()}@example.org`;
    await createAccount(pool, otherEmail, password, "pathologist");
    const other = browser();
    await other.request("/api/v1/auth/session");
    await other.request("/api/v1/auth/login", { method: "POST", body: { email: otherEmail, password } });
    const empty = await other.request("/api/v1/submissions");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { submissions: [], pageInfo: { hasMore: false, nextCursor: null } });
    const foreignCursor = await other.request(`/api/v1/submissions?cursor=${first.data.pageInfo.nextCursor}`);
    assert.deepEqual(foreignCursor.data, empty.data);
  });

  // Separate limiter instance: these cases must not consume the authentication
  // lifecycle's per-IP request budget.
  const analysisBase = await start();
  const analysisBrowser = () => browser(analysisBase);
  const analysisOwner = analysisBrowser();
  await analysisOwner.login();
  await analysisTests(t, {pool, storage: imageStorage, browser: analysisBrowser, owner: analysisOwner, ownerId: weekSession.data.user.id});

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

  await t.test("production cookie is secure through DCISM loopback TLS proxy mode", async () => {
    const client = browser(await start({ secureCookies: true, trustLocalHttpsProxy: true }));
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
