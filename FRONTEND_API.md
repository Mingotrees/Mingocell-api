# MingoCell Frontend API Handoff

> Frontend agent: treat this file as the browser integration contract. Use only
> capabilities marked **Available**. Do not invent endpoints for planned work.

| Field | Value |
| --- | --- |
| Contract status | Current implementation plus explicit gaps |
| Last verified | 2026-10-04 |
| Backend commit | `2eeb6ba` |
| Production API | `https://api-mingocell.dcism.org` |
| Production frontend | `https://mingocells.dcism.org` |

If this document conflicts with backend behavior, tests and source code are the
source of truth. Report the drift and update this file with the backend change.

## Capability Matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Liveness and database readiness | **Available** | Public health endpoints |
| Session bootstrap and restoration | **Available** | PostgreSQL-backed cookie session |
| Email/password login | **Available** | Accounts are provisioned by an administrator |
| Logout | **Available** | Ends only the current browser session |
| Role information | **Available** | `pathologist` or `admin` returned with the session |
| Public signup | **Unavailable** | No signup endpoint |
| Browser password reset | **Unavailable** | Server CLI only |
| Browser account administration | **Unavailable** | Server CLI only, including for `admin` users |
| Image/file upload | **Unavailable** | No multipart or storage API |
| Predictions/inference | **Unavailable** | No model endpoint or inference readiness check |
| Submission/history/detail views | **Unavailable** | No records or endpoints |
| Expert review | **Unavailable** | Role guard exists, but no review endpoint |
| Realtime updates | **Unavailable** | No WebSocket, SSE, or event contract |

The frontend can currently implement health display and authentication. Product
screens for unavailable capabilities need mocked local data or an explicit
backend contract before integration.

## Environments

Use these public frontend variables if they still match the frontend repository:

```dotenv
# Local frontend build
NEXT_PUBLIC_API_URL=http://localhost:20282
NEXT_PUBLIC_API_ENABLED=true

# Production frontend build
NEXT_PUBLIC_API_URL=https://api-mingocell.dcism.org
NEXT_PUBLIC_API_ENABLED=true
```

`NEXT_PUBLIC_API_ENABLED` is a frontend feature flag, not a backend setting.
`NEXT_PUBLIC_*` values are public and embedded at build time. Never put secrets,
passwords, cookies, or CSRF tokens in them.

### Local hostname rule

Run the frontend at `http://localhost:3000` and call the API as
`http://localhost:20282`. Do not mix a `localhost` frontend with a
`127.0.0.1` API URL. Browsers treat those as different sites, which can prevent
the `SameSite=Lax` session cookie from being sent on `fetch` requests. The API
may still bind its server socket to `127.0.0.1`.

Do not connect a local frontend directly to the production API. The production
cookie is designed for the deployed HTTPS sites, not cross-site local requests.

## Browser Contract

- All browser API calls must use `credentials: "include"`.
- Authentication uses an opaque HttpOnly cookie, not a bearer token or JWT.
- Never read, store, or log the session cookie. Browser JavaScript cannot access it.
- Keep the returned CSRF token in memory. Do not put it in local storage.
- Send the latest `X-CSRF-Token` on every unsafe request (`POST`, `PUT`,
  `PATCH`, `DELETE`, and similar methods).
- Authentication payloads use `Cache-Control: no-store`.
- Successful logout returns an empty `204` response. Do not parse it as JSON.
- Other successful endpoints and all normal errors return JSON.
- Timestamps are ISO 8601 UTC strings.
- Request and response JSON uses camelCase.

## Shared Types

These are the complete browser-visible authentication types today:

```ts
export type Role = "pathologist" | "admin";

export type PublicUser = {
  id: string; // UUID
  email: string;
  role: Role;
};

export type SessionResponse = {
  user: PublicUser | null;
  csrfToken: string; // 64 lowercase hexadecimal characters
  expiresAt: string | null; // ISO 8601 UTC
  rememberMe: boolean;
};

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

export type LiveResponse = {
  status: "ok";
  service: "mingocell-api";
};

export type ReadyResponse =
  | { status: "ready" }
  | {
      status: "unavailable";
      error: {
        code: "DATABASE_UNAVAILABLE";
        message: string;
      };
    };
```

Do not depend on internal fields such as `active`, `auth_version`, password
hashes, or database timestamps. They are not part of the public contract.

## Authentication State Machine

1. On app startup, call `GET /api/v1/auth/session`.
2. Save `csrfToken` in memory and render from `user`.
3. If `user` is null, show the login screen.
4. Login using the current CSRF token and cookie.
5. Replace both user state and the in-memory CSRF token with the login response.
6. On page reload, call the session endpoint again to restore state.
7. On an authenticated request returning `401 UNAUTHENTICATED`, clear local user
   state, bootstrap a fresh anonymous session, and route to login. Do not
   automatically retry the unsafe request.
8. Logout using the latest CSRF token. Clear local user and token state after a
   successful `204`, then bootstrap again before another login attempt.

A stale or expired cookie behaves specially on the bootstrap endpoint:
`GET /api/v1/auth/session` destroys the stale session and returns a new anonymous
session with status `200`. Other requests using that stale session return
`401 UNAUTHENTICATED`.

### Session lifetimes

| Session state | Absolute lifetime |
| --- | --- |
| Anonymous bootstrap | 1 hour |
| Login with `rememberMe: false` | 8 hours |
| Login with `rememberMe: true` | 7 days |

Activity does not extend these deadlines. Sessions survive API process restarts
because PostgreSQL stores them. Password reset, account deactivation, and account
version changes revoke all sessions for that account. Logout revokes only the
current browser session.

### Cookies

| Environment | Name | Attributes |
| --- | --- | --- |
| Development | `mingocell.sid` | Host-only, HttpOnly, `SameSite=Lax`, `Path=/` |
| Production | `__Host-mingocell.sid` | Host-only, HttpOnly, Secure, `SameSite=Lax`, `Path=/` |

## Endpoint Catalog

There are no query parameters or path parameters in the current API.

### `GET /health/live`

Checks whether the API process can answer HTTP requests. No authentication or
session is required. This does not check PostgreSQL or future model/storage
dependencies.

Response `200`:

```json
{
  "status": "ok",
  "service": "mingocell-api"
}
```

### `GET /health/ready`

Checks PostgreSQL connectivity with `SELECT 1`. No authentication or session is
required. This does not check migrations, inference, or storage.

Response `200`:

```json
{
  "status": "ready"
}
```

Response `503`:

```json
{
  "status": "unavailable",
  "error": {
    "code": "DATABASE_UNAVAILABLE",
    "message": "Database connection unavailable."
  }
}
```

### `GET /api/v1/auth/session`

Creates an anonymous session when needed and returns current authentication
state. Authentication is optional. Always use `credentials: "include"`.

Signed-out response `200`:

```json
{
  "user": null,
  "csrfToken": "64-lowercase-hex-characters",
  "expiresAt": null,
  "rememberMe": false
}
```

Signed-in response `200`:

```json
{
  "user": {
    "id": "34da8ee0-70b2-47d8-9be1-410422e59da2",
    "email": "expert@example.org",
    "role": "pathologist"
  },
  "csrfToken": "64-lowercase-hex-characters",
  "expiresAt": "2026-10-04T20:30:00.000Z",
  "rememberMe": false
}
```

Possible failures are `403 ORIGIN_FORBIDDEN`, `429 RATE_LIMITED`, and
`500 INTERNAL_ERROR`. A stale authenticated session is converted into a new
anonymous `200` response rather than returning `401` on this endpoint.

### `POST /api/v1/auth/login`

Requires an anonymous or existing session, allowed browser origin, matching CSRF
token, credentials, and JSON content.

Headers:

```http
Content-Type: application/json
X-CSRF-Token: <token from latest session response>
```

Body:

```json
{
  "email": "expert@example.org",
  "password": "user-entered password",
  "rememberMe": false
}
```

Input rules:

- `email` is required, trimmed, lowercased, validated, and limited to 254 characters.
- `password` must be a nonempty string no longer than 128 characters for login.
- `rememberMe` is optional, defaults to `false`, and must be a boolean.
- Extra body fields are currently ignored, but clients should not send them.
- Unknown email, wrong password, and inactive account all return the same error.

Response `200` uses the signed-in `SessionResponse` shape. Successful login
rotates both session ID and CSRF token. Always replace the old CSRF token with
the response token.

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `INVALID_INPUT` | Invalid email, password, or `rememberMe` type |
| `400` | `INVALID_JSON` | Malformed JSON |
| `401` | `INVALID_CREDENTIALS` | Unknown email, wrong password, or inactive account |
| `403` | `CSRF_INVALID` | Missing/wrong token or missing allowed origin |
| `403` | `ORIGIN_FORBIDDEN` | Explicit disallowed origin |
| `413` | `BODY_TOO_LARGE` | JSON body exceeds 16 KB |
| `429` | `RATE_LIMITED` | General, per-IP login, or per-email login limit reached |
| `500` | `INTERNAL_ERROR` | Internal, database, or session failure |

Invalid credential response:

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password."
  }
}
```

### `POST /api/v1/auth/logout`

Requires an authenticated session, allowed origin, current CSRF token, and
credentials. No request body is needed.

Success: `204 No Content`. The current server session is deleted and its cookie
is cleared. Other browsers and devices stay signed in.

Possible failures:

| Status | Code | Meaning |
| --- | --- | --- |
| `401` | `UNAUTHENTICATED` | No current authenticated user or stale session |
| `403` | `CSRF_INVALID` | Missing/wrong token or missing allowed origin |
| `403` | `ORIGIN_FORBIDDEN` | Explicit disallowed origin |
| `429` | `RATE_LIMITED` | General API limit reached |
| `500` | `INTERNAL_ERROR` | Internal, database, or session failure |

CSRF validation runs before the logout route's authentication guard. An
anonymous request with a missing or invalid CSRF token therefore returns `403`;
an anonymous request with a valid anonymous token returns `401`.

### Unknown routes and methods

Unknown routes return `404`:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found."
  }
}
```

There is no separate `405 Method Not Allowed` response. Unsupported methods
normally become `404`; unsafe `/api/v1/*` requests can fail CSRF validation first.

## Errors and Transport

Normal API errors use:

```json
{
  "error": {
    "code": "UPPER_SNAKE_CASE",
    "message": "Human-readable message."
  }
}
```

The readiness `503` response additionally includes top-level `status`. Do not
assume every error body contains only the `error` property.

| Status | Common codes |
| --- | --- |
| `400` | `INVALID_INPUT`, `INVALID_JSON` |
| `401` | `INVALID_CREDENTIALS`, `UNAUTHENTICATED` |
| `403` | `CSRF_INVALID`, `ORIGIN_FORBIDDEN`, `FORBIDDEN`, `PROXY_FORBIDDEN` |
| `404` | `NOT_FOUND` |
| `413` | `BODY_TOO_LARGE` |
| `429` | `RATE_LIMITED` |
| `500` | `INTERNAL_ERROR` |
| `503` | `DATABASE_UNAVAILABLE` |

Every response receives an `X-Request-ID` UUID. The current CORS configuration
does not expose that header, so cross-origin browser JavaScript cannot reliably
read it. Rate-limit headers have the same limitation. Do not make UI behavior
depend on either header until the backend explicitly exposes them.

### Rate limits

- Every `/api/v1/*` request: 120 requests per 15 minutes per IP.
- Login: an additional 10 requests per 15 minutes per IP.
- Login: another 10 requests per 15 minutes per normalized email hash.
- Successful login requests count toward these limits.
- Counters are in memory, reset on restart, and are not shared across replicas.

Use the error body for `429` UI. Display a generic retry-later message; the
browser cannot currently depend on rate-limit response headers.

### CORS and CSRF

Default allowed origins:

```text
https://mingocells.dcism.org
http://localhost:3000
```

CORS behavior:

- Exact origins only, with no trailing slash.
- Credentialed requests are enabled.
- Allowed methods are `GET`, `POST`, and `OPTIONS`.
- Allowed non-safelisted request headers are `Content-Type` and `X-CSRF-Token`.
- `Authorization` is neither allowed nor used.
- Explicit disallowed origins are rejected globally, including health requests.
- Because origin rejection occurs before CORS headers are added, browsers may
  surface it as a network/CORS failure instead of readable
  `403 ORIGIN_FORBIDDEN` JSON.

Browsers supply `Origin`; frontend code must not try to set it manually.

## Next.js/TypeScript Client Pattern

This pattern is for direct browser calls from client components or client-side
state code. Do not call it during static generation. A Next.js server-side proxy
would need a separate design for forwarding cookies and origin/CSRF semantics.

```ts
// lib/mingocell-api.ts
export type Role = "pathologist" | "admin";

export type PublicUser = {
  id: string;
  email: string;
  role: Role;
};

export type SessionResponse = {
  user: PublicUser | null;
  csrfToken: string;
  expiresAt: string | null;
  rememberMe: boolean;
};

type ApiErrorResponse = {
  error: { code: string; message: string };
};

const API_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_URL) {
  throw new Error("NEXT_PUBLIC_API_URL is required");
}

let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";

  if (!safe && !csrfToken) {
    await getSession();
  }

  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (!safe && csrfToken) headers.set("X-CSRF-Token", csrfToken);

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    method,
    headers,
    credentials: "include",
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json()) as T | ApiErrorResponse;
  if (!response.ok) {
    const error = (payload as ApiErrorResponse).error;
    throw new ApiError(response.status, error?.code ?? "UNKNOWN_ERROR", error?.message ?? "Request failed.");
  }

  return payload as T;
}

export async function getSession(): Promise<SessionResponse> {
  const session = await apiRequest<SessionResponse>("/api/v1/auth/session");
  csrfToken = session.csrfToken;
  return session;
}

export async function login(input: {
  email: string;
  password: string;
  rememberMe?: boolean;
}): Promise<SessionResponse> {
  if (!csrfToken) await getSession();

  const session = await apiRequest<SessionResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      rememberMe: input.rememberMe ?? false,
    }),
  });
  csrfToken = session.csrfToken;
  return session;
}

export async function logout(): Promise<void> {
  await apiRequest<void>("/api/v1/auth/logout", { method: "POST" });
  csrfToken = null;
}
```

This minimal wrapper assumes backend JSON for non-`204` responses. A production
frontend may add runtime schema validation and a dedicated network/CORS error
type. It must preserve credentials, CSRF replacement after login, and no unsafe
automatic retries.

## Authorization

| Operation | Anonymous | `pathologist` | `admin` |
| --- | --- | --- | --- |
| Health checks | Allowed | Allowed | Allowed |
| Read session | Allowed | Allowed | Allowed |
| Login | Allowed | Allowed | Allowed |
| Logout | Denied | Allowed | Allowed |
| Pathologist-only future route | Denied | Allowed | Denied |

Roles are exact, not hierarchical. `admin` does not inherit `pathologist`
permission. No currently exposed product endpoint uses a role guard, so do not
infer additional role capabilities.

## Frontend Agent Checklist

- Set `NEXT_PUBLIC_API_URL` to the correct build-time URL.
- Use `http://localhost:20282`, not `http://127.0.0.1:20282`, from local browser code.
- Keep all API calls client-side unless a server proxy contract is designed.
- Bootstrap the session before rendering authenticated routes.
- Include credentials on every request.
- Keep CSRF only in memory and replace it after login/session responses.
- Treat `user: null` as signed out, not as an API failure.
- Do not parse a successful logout as JSON.
- Handle network/CORS failures separately from JSON API errors.
- Route `401 UNAUTHENTICATED` to a fresh bootstrap and login; do not retry writes.
- Do not show signup, reset-password, upload, prediction, history, or review as
  connected features until backend endpoints exist.
- Never log passwords, cookies, CSRF tokens, or full authentication request bodies.

## Contract Maintenance

Update this file in the same change whenever backend work changes any of these:

- Route method or path
- Request headers, parameters, or body
- Response body, status, error code, or error ordering
- Authentication, role, cookie, CSRF, or CORS behavior
- Session lifetime or invalidation behavior
- Rate limits or browser-readable response headers
- Public environment URL or API version
- Capability availability

Maintenance procedure:

1. Run `graphify update .` after backend source changes.
2. Use `graphify query`, `graphify explain`, `graphify path`, and
   `graphify affected` to trace changed routes and middleware.
3. Verify behavior against HTTP tests, not documentation alone.
4. Update the capability matrix, endpoint section, shared types, examples,
   frontend checklist, verification date/commit, and changelog as applicable.
5. Never describe a proposed endpoint as available before implementation and tests land.

Primary contract sources:

- `src/app.ts`: global middleware, health routes, CORS, errors, request IDs
- `src/auth/routes.ts`: session, login, logout, payloads, login throttles
- `src/auth/middleware.ts`: cookies, sessions, roles, CSRF, general throttling
- `src/auth/passwords.ts`: email and password validation
- `tests/server.test.mjs`: health and not-found contract checks
- `tests/auth.test.mjs`: browser authentication lifecycle checks

## Change Log

| Date | Backend commit | Change |
| --- | --- | --- |
| 2026-10-04 | `2eeb6ba` | Created frontend handoff for implemented health and authentication contracts |
