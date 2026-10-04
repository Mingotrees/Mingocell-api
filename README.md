# MingoCell API

Express 5 + TypeScript. Requires Node.js 24 or newer.

## Source structure

```text
src/
├── app.ts                       Express app, global middleware, health checks, errors
├── server.ts                    HTTP startup and graceful shutdown
├── logging.ts                   Audit-safe structured operational logging
├── database/
│   ├── pool.ts                  PostgreSQL connection pool
│   └── migration-runner.ts      Transactional SQL migration runner
├── auth/
│   ├── routes.ts                Session, login, and logout endpoints
│   ├── middleware.ts            Sessions, CSRF, account checks, role guards, configuration
│   ├── accounts.ts              Account creation, password reset, deactivation
│   └── passwords.ts             Email validation and password hashing/verification
└── cli/
    ├── manage-account.ts        Hidden-prompt account management command
    └── migrate-database.ts      Migration command entry point
```

`server.ts` connects the database pool and auth configuration to `app.ts`.
Auth routes install their middleware before registering endpoints. Server-only
maintenance commands live in `cli/`; SQL files remain in root `migrations/`.
Builds clean `dist/` before compiling so renamed modules cannot leave stale output.
Run commands through `npm run account` and `npm run migrate`; compiled CLI files
now live under `dist/cli/`.

## Local development

```bash
npm install
npm run build
npm run migrate
npm run dev
```

`npm run dev` builds and starts the server. Restart it after source changes.
Optional `.env` settings are documented in `.env.example`; default address is
`127.0.0.1:20282`.

```bash
curl http://127.0.0.1:20282/health/live
npm test
```

Set the `DB_*` variables and `SESSION_SECRET` in local `.env` before starting.
Local school-database access requires your SSH tunnel; its host/port can differ
from production. `npm run dev` uses development cookies for local HTTP;
`npm start` forces production mode with secure cookies.

Liveness returns `{"status":"ok","service":"mingocell-api"}`. Database readiness
is `GET /health/ready`, returning `{"status":"ready"}` or HTTP 503.
Inference is not connected yet.

## PM2

Run from the project directory, on the machine hosting the API:

```bash
npm ci
npm run build
npm run migrate
pm2 start npm --name mingocell-api -- start
pm2 list
pm2 logs mingocell-api
```

The start script loads `.env` if present. On DCISM, use assigned port `20282`.
Default loopback binding assumes the school's reverse proxy runs on the same
host; confirm its binding requirements before exposing the API.

After updating source:

```bash
npm ci
npm run build
npm run migrate
pm2 restart mingocell-api --update-env
```

```bash
pm2 stop mingocell-api
pm2 delete mingocell-api
```

Follow DCISM's instructions for reboot persistence. `pm2 save` saves the process
list but does not itself install a boot service.

## Structured operational logs

The API writes one JSON object per line so PM2 can retain searchable,
request-correlated operational events. Inspect them on the server with:

```bash
pm2 logs mingocell-api
pm2 logs mingocell-api --err
```

Every entry contains `timestamp`, `service`, `level`, and `event`. Completed HTTP
requests also include the server-generated `requestId`, method, matched route
template, status, duration in milliseconds, and authenticated actor UUID/role
when available. Use that request ID with the response's `X-Request-ID` header to
trace a reported failure.

```json
{"timestamp":"2026-10-04T09:30:00.000Z","service":"mingocell-api","level":"info","event":"http.request.completed","requestId":"fe9a54e6-98df-43c7-930c-60caddc5890d","method":"GET","route":"/health/live","status":200,"durationMs":1.274}
```

Logs use matched route templates rather than raw URLs and never intentionally
include query values, request bodies, headers, IP addresses, emails, passwords,
cookies, authorization values, CSRF tokens, filenames, image data, or review
notes. Unexpected errors record only a safe error type and request context, not
the exception message. Error events go to stderr; info and warning events go to
stdout.

These logs support deployment and incident troubleshooting. They are not the
append-only prediction/review audit history required by the product workflow;
that history must be persisted separately with the future record endpoints.

## GitHub Actions CI/CD

`.github/workflows/deploy.yml` runs `npm ci` and `npm test` (including the
TypeScript build) on pull requests and pushes to `main`. Successful pushes to
`main` also deploy. Manual runs deploy only when `main` is selected.

Configure these repository secrets under **Settings → Secrets and variables →
Actions**:

| Secret | Value |
| --- | --- |
| `DCISM_SSH_KEY` | Private deployment key authorized for the school account |
| `DCISM_KNOWN_HOSTS` | Verified SSH host-key entry for `[ver.dcism.org]:22072` |
| `DCISM_HOST` | `ver.dcism.org` |
| `DCISM_PORT` | `22072` |
| `DCISM_USER` | `s22101440` |
| `DCISM_DEPLOY_PATH` | `/data/users/s22101440/api-mingocell.dcism.org` (no trailing slash) |

The server directory must already exist and PM2 must already manage
`mingocell-api` from that directory. Node 24+, npm, PM2, rsync, and curl must be
available in noninteractive SSH sessions. Target settings are checked against
fixed assertions in the workflow; update both if the destination changes.

Deployment uploads compiled `dist/`, SQL migrations, and the package manifests,
installs production dependencies, runs migrations, and restarts PM2. Only obsolete files inside `dist/`
are deleted. Server `.env` is preserved; keep private images and other persistent
data outside `dist/`, preferably outside the deployment directory.

Before upload, the workflow requires a configured server `SESSION_SECRET`.
After restart, local liveness/readiness and public HTTPS liveness/authentication
bootstrap checks must pass. Inspect each run
in **Actions → Test and deploy to DCISM**. Backend deployments are serialized.

Updates happen in place and may briefly interrupt requests. There is no automatic
rollback: if installation, restart, or verification fails, inspect PM2 logs and
redeploy a known-good revision. A successful health check confirms liveness,
not database readiness or inference availability.

## Authentication setup

Accounts are provisioned by an administrator; there is no public signup.
Email addresses are validated, trimmed, and lowercased. Passwords must contain
12–128 characters and are stored as salted scrypt hashes, not plaintext.

Before deploying authentication, generate a session signing secret:

```bash
openssl rand -hex 32
```

Put the generated value in `SESSION_SECRET` in the server's private `.env`.
Generate a separate value for local development. Never commit these values or
paste them into logs. Changing the secret invalidates existing signed cookies.
`CORS_ORIGINS` defaults to `https://mingocells.dcism.org,http://localhost:3000`;
use exact origins without trailing slashes. Do not set a wildcard.

DCISM Apache terminates HTTPS on the same server but does not forward the
original protocol. Its production `.env` must therefore contain:

```dotenv
HOST=127.0.0.1
TRUST_LOCAL_HTTPS_PROXY=true
```

This mode overwrites forwarding protocol data only for loopback connections and
refuses to start on a public bind address. Leave it false locally. It preserves
Secure, HttpOnly, host-only cookies without trusting internet-supplied proxy
headers.

Run account commands **on the server**, from the backend directory after migrations:

```bash
npm run account -- create expert@example.org pathologist
npm run account -- create admin@example.org admin
npm run account -- reset-password expert@example.org
npm run account -- deactivate expert@example.org
```

Passwords are entered twice through a hidden terminal prompt, never supplied as
command-line arguments. School SSH access and database credentials authorize
these tools; a browser admin session does not expose account administration.
`admin` does not grant expert-review permission. Resetting passwords or
deactivating accounts revokes all their sessions; resetting a disabled account
does not reactivate it.

Migrations run transactionally with a database lock and checksum tracking. Run
`npm run build && npm run migrate` locally before starting. CI/CD runs migrations
automatically on production before restarting PM2. Do not edit an applied SQL
migration; add a new numbered file for later schema changes.
Migration `002_rename_maintainer_to_admin.sql` reasserts the role constraint
after the already-deployed first migration; the runner skips unchanged files.

## Authentication API contract

All browser calls must use `credentials: 'include'`. Responses are JSON except
successful logout (204). Authentication responses use `Cache-Control: no-store`.

1. **Bootstrap:** `GET /api/v1/auth/session` creates an anonymous session and
   returns `{user: null, csrfToken, expiresAt: null, rememberMe: false}` when
   signed out. Save the returned CSRF token in memory.
2. **Login:** `POST /api/v1/auth/login` with JSON
   `{email, password, rememberMe: false}`. Supply `X-CSRF-Token` from step 1;
   browsers supply the allowed `Origin` header. `rememberMe` is optional and must
   be boolean. Login rotates both the session ID and CSRF token.
3. **Current session:** `GET /api/v1/auth/session` returns the same response shape
   as login. `user` is `{id, email, role}`, or null when signed out. `expiresAt`
   is an ISO UTC timestamp. Use the latest `csrfToken` for writes.
4. **Logout:** `POST /api/v1/auth/logout` with current `X-CSRF-Token` and allowed
   `Origin`. Returns 204, deletes the current session and clears its cookie.
   Other browsers/devices remain signed in.

Example login after session bootstrap:

```js
const api = 'https://api-mingocell.dcism.org';
const sessionResponse = await fetch(`${api}/api/v1/auth/session`, {
  credentials: 'include',
});
if (!sessionResponse.ok) throw new Error('Session unavailable');
const session = await sessionResponse.json();

const loginResponse = await fetch(`${api}/api/v1/auth/login`, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
  },
  body: JSON.stringify({ email, password, rememberMe }),
});
// Check loginResponse.ok, validate its response, and replace the in-memory CSRF token.
```

Normal sessions expire 8 hours after login; remembered sessions expire after
7 days. Activity does not extend the deadline. PostgreSQL holds sessions across
PM2 restarts. Expiry, deactivation, and password-version changes are enforced
server-side. Cookies are host-only, HttpOnly, SameSite=Lax and Secure in
production (`__Host-mingocell.sid`). Local development uses `mingocell.sid`
without Secure; use the local frontend with the local API, not the production
API, because SameSite cookies do not work across unrelated sites.

Express trusts loopback proxies only. `TRUST_LOCAL_HTTPS_PROXY=true` handles the
school proxy's missing protocol header and is safe only while `HOST` remains a
loopback address.

Errors use `{error: {code, message}}`: invalid input/JSON (400), invalid
credentials or missing/expired authentication (401), rejected origin/CSRF or
role (403), oversized JSON body (413), and throttling (429). Invalid passwords,
unknown emails, and disabled accounts share the same generic login error.
Login is limited to 10 attempts per 15 minutes per IP and per normalized email;
API requests are limited to 120 per 15 minutes per IP. Throttles are in-process
for the current single PM2 instance; use a shared store before adding replicas.
Request IDs are returned in `X-Request-ID`; passwords, cookies, and CSRF tokens
must not be logged. No frontend login wiring is included in this backend change.

## Authentication checks

`npm test` runs HTTP and password/role tests without school credentials.
Database integration tests also run when `TEST_DATABASE_URL` targets an isolated
database named **mingocell_test**; they never read local `.env` or reuse `DB_*`.

```bash
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:PORT/mingocell_test npm test
```

Integration checks cover migration repeatability, duplicate emails, CSRF,
session rotation/persistence, cookie flags, fixed expiry, current-browser logout,
password reset/deactivation, error redaction, and throttling. GitHub Actions
provisions disposable PostgreSQL 16 and runs all checks before deployment.
CI also runs `python3 tests/account-cli.py` with the same test database to verify
that passwords never echo in the account command's terminal prompts. This
check uses Python's standard library; Python is not needed to run the API.
