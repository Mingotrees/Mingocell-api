# MingoCell Frontend API Handoff

> Frontend agent: treat this file as the browser integration contract. Use only
> capabilities marked **Available**. Do not invent endpoints for planned work.

| Field | Value |
| --- | --- |
| Contract status | Current implementation plus explicit gaps |
| Last verified | 2026-10-05 |
| Backend commit | Pending commit, based on `85f545b` |
| Production API | `https://api-mingocell.dcism.org` |
| Production frontend | `https://mingocells.dcism.org` |

If this document conflicts with backend behavior, tests and source code are the
source of truth. Report the drift and update this file with the backend change.

## Capability Matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Liveness and database/storage readiness | **Available** | Public health endpoints |
| Session bootstrap and restoration | **Available** | PostgreSQL-backed cookie session |
| Email/password login | **Available** | Accounts are provisioned by an administrator |
| Logout | **Available** | Ends only the current browser session |
| Role information | **Available** | `pathologist` or `admin` returned with the session |
| Public signup | **Unavailable** | No signup endpoint |
| Browser password reset | **Unavailable** | Server CLI only |
| Browser account administration | **Unavailable** | Server CLI only, including for `admin` users |
| Image/file upload | **Available** | Private PNG, JPEG, and TIFF intake |
| Predictions/inference | **Unavailable** | No model endpoint or inference readiness check |
| Submission detail and image access | **Available** | Owner-scoped detail, original, and preview endpoints |
| Submission history | **Unavailable** | No list or filter endpoint |
| Expert review | **Unavailable** | Role guard exists, but no review endpoint |
| Realtime updates | **Unavailable** | No WebSocket, SSE, or event contract |

The frontend can currently implement health display, authentication, image
upload, and immediate submission detail. Product screens for unavailable
capabilities need mocked local data or an explicit backend contract before
integration.

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

These are the browser-visible authentication and image-intake types today:

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

export type UploadResponse = {
  image: {
    id: string;
    format: "jpeg" | "png" | "tiff";
    byteSize: number;
    pageCount: number;
    sha256: string;
    uploadedAt: string;
  };
  submissions: Array<{
    id: string;
    pageIndex: number;
    width: number;
    height: number;
    status: "uploaded";
    imageUrl: string;
    previewUrl: string;
  }>;
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
        code: "DATABASE_UNAVAILABLE" | "STORAGE_UNAVAILABLE";
        message: string;
      };
    };

export type SubmissionResponse = {
  id: string;
  pageIndex: number;
  width: number;
  height: number;
  status: "uploaded" | "analyzed" | "failed";
  createdAt: string;
  source: {
    format: "jpeg" | "png" | "tiff";
    byteSize: number;
    sha256: string;
    pageCount: number;
  };
  imageUrl: string;
  previewUrl: string;
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

Submission read endpoints use a UUID path parameter. There are no query
parameters in the current API.

### `GET /health/live`

Checks whether the API process can answer HTTP requests. No authentication or
session is required. This does not check PostgreSQL, image storage, or future
inference dependencies.

Response `200`:

```json
{
  "status": "ok",
  "service": "mingocell-api"
}
```

### `GET /health/ready`

Checks PostgreSQL connectivity with `SELECT 1`, validates all private storage
directories, performs a temporary write/remove probe, and verifies enough free
space remains for the configured reserve plus one worst-case upload. No
authentication or session is required. This does not check migrations or
inference.

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

The error code is `DATABASE_UNAVAILABLE` when PostgreSQL fails, or
`STORAGE_UNAVAILABLE` with message `Image storage unavailable.` when a storage
directory cannot be read or written.

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

### `POST /api/v1/submissions`

Stores one private source file and creates one `uploaded` submission per image
page. Requires an authenticated session, allowed origin, current CSRF token, and
an idempotency key.

Headers and body:

```http
Content-Type: multipart/form-data; boundary=<browser-generated>
X-CSRF-Token: <token from latest session response>
Idempotency-Key: <8-128 safe characters; UUID recommended>
```

The multipart body must contain exactly one file field named `image` and no text
fields. Let `fetch` set the multipart `Content-Type`; manually setting it omits
the boundary and breaks parsing.

Accepted input:

- PNG, JPEG, or TIFF, detected from decoded bytes rather than filename/MIME type.
- At most 5,242,880 bytes (5 MiB).
- At most 4,000,000 pixels per page and 20,000,000 pixels across the file.
- At most 20 TIFF pages. PNG/JPEG must be single-page.
- Every TIFF page must represent an independent cell image. Each page creates a
  separate submission with a zero-based `pageIndex`.
- The complete pixel payload is decoded before success. Corrupt later TIFF pages
  fail the whole upload.
- The complete HTTP request body must arrive within 60 seconds.

Success `201`:

```json
{
  "image": {
    "id": "0aa26902-2192-4fdf-8d34-d31993a66f02",
    "format": "tiff",
    "byteSize": 243118,
    "pageCount": 1,
    "sha256": "64-lowercase-hex-characters",
    "uploadedAt": "2026-10-05T03:52:26.000Z"
  },
  "submissions": [
    {
      "id": "488b9de8-470d-460b-82f2-0106aff5bc26",
      "pageIndex": 0,
      "width": 288,
      "height": 288,
      "status": "uploaded",
      "imageUrl": "/api/v1/submissions/488b9de8-470d-460b-82f2-0106aff5bc26/image",
      "previewUrl": "/api/v1/submissions/488b9de8-470d-460b-82f2-0106aff5bc26/preview"
    }
  ]
}
```

`uploaded` means persisted, not analyzed. No model output exists. Originals stay
unchanged; previews are JPEG derivatives. Preprocessed model inputs are not
stored.

If delivery fails, retry the same bytes with the same idempotency key. A completed
retry returns the original `201` body and `Idempotency-Replayed: true`. Reusing
the key with different bytes returns `409 IDEMPOTENCY_CONFLICT`. Generate a new
key for a deliberate second submission of the same image.

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `IMAGE_REQUIRED` | Missing `image` file field |
| `400` | `INVALID_MULTIPART` | Extra file/field, malformed multipart, or wrong field name |
| `400` | `IDEMPOTENCY_KEY_INVALID` | Missing or malformed idempotency key |
| `400` | `INVALID_IMAGE` | Empty, corrupt, or undecodable image |
| `401` | `UNAUTHENTICATED` | No current authenticated user |
| `403` | `CSRF_INVALID`, `ORIGIN_FORBIDDEN` | Browser security validation failed |
| `409` | `IDEMPOTENCY_CONFLICT` | Key was used for different bytes |
| `413` | `IMAGE_TOO_LARGE` | File exceeds 5 MiB |
| `413` | `IMAGE_TOO_MANY_PIXELS` | Per-page or aggregate pixel limit exceeded |
| `413` | `TOO_MANY_PAGES` | TIFF exceeds 20 pages |
| `415` | `UNSUPPORTED_IMAGE_FORMAT` | Content is not supported PNG/JPEG/TIFF |
| `429` | `RATE_LIMITED` | General or upload-specific limit reached |
| `429` | `UPLOAD_BUSY` | This owner or process already has maximum in-flight uploads |
| `500` | `INTERNAL_ERROR` | Persistence or processing failed |
| `507` | `STORAGE_QUOTA_EXCEEDED`, `STORAGE_CAPACITY_LOW` | Owner quota or server free-space reserve reached |

### `GET /api/v1/submissions/:id`

Returns persisted metadata for a submission owned by the authenticated user.
Another user's ID and an unknown/malformed ID both return
`404 SUBMISSION_NOT_FOUND`; this avoids revealing record existence. Success uses
`SubmissionResponse` from Shared Types.

### `GET /api/v1/submissions/:id/image`

Streams the immutable original source file as an attachment. For a page from a
multi-page TIFF, this returns the complete original TIFF; `pageIndex` identifies
the submission's page. Requires ownership. Response includes the detected image
MIME type, `Content-Length`, attachment disposition, and
`X-Content-Type-Options: nosniff`.

### `GET /api/v1/submissions/:id/preview`

Streams the submission page's JPEG preview inline. Requires ownership. The
preview is for browser display only; future inference must use the original page.
`imageUrl` and `previewUrl` are API-relative paths. Resolve them against
`NEXT_PUBLIC_API_URL`, not the frontend origin:

```ts
const previewSrc = new URL(submission.previewUrl, API_URL).toString();
```

Image responses override Helmet's resource policy with
`Cross-Origin-Resource-Policy: same-site`, matching the production frontend/API
subdomains. Requests still need the session cookie.

All three read endpoints may return `401 UNAUTHENTICATED`,
`404 SUBMISSION_NOT_FOUND`, `429 RATE_LIMITED`, or `500 INTERNAL_ERROR`. Image
and preview retrieval can also return `503 STORAGE_UNAVAILABLE` when a referenced
file is missing or unreadable.

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
| `400` | `INVALID_INPUT`, `INVALID_JSON`, `INVALID_MULTIPART`, `INVALID_IMAGE`, `IMAGE_REQUIRED`, `IDEMPOTENCY_KEY_INVALID` |
| `401` | `INVALID_CREDENTIALS`, `UNAUTHENTICATED` |
| `403` | `CSRF_INVALID`, `ORIGIN_FORBIDDEN`, `FORBIDDEN`, `PROXY_FORBIDDEN` |
| `404` | `NOT_FOUND`, `SUBMISSION_NOT_FOUND` |
| `409` | `IDEMPOTENCY_CONFLICT` |
| `413` | `BODY_TOO_LARGE`, `IMAGE_TOO_LARGE`, `IMAGE_TOO_MANY_PIXELS`, `TOO_MANY_PAGES` |
| `415` | `UNSUPPORTED_IMAGE_FORMAT` |
| `429` | `RATE_LIMITED`, `UPLOAD_BUSY` |
| `500` | `INTERNAL_ERROR` |
| `503` | `DATABASE_UNAVAILABLE`, `STORAGE_UNAVAILABLE` |
| `507` | `STORAGE_QUOTA_EXCEEDED`, `STORAGE_CAPACITY_LOW` |

Every response receives an exposed `X-Request-ID` UUID. Upload replays expose
`Idempotency-Replayed`. Rate-limit headers are not part of the frontend contract;
use the `429` error body for UI behavior.

### Rate limits

- Every `/api/v1/*` request: 120 requests per 15 minutes per IP.
- Login: an additional 10 requests per 15 minutes per IP.
- Login: another 10 requests per 15 minutes per normalized email hash.
- Upload: an additional 20 requests per 15 minutes per IP.
- Upload decoding: at most two concurrent uploads per API process and one per owner.
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
- Allowed non-safelisted request headers are `Content-Type`, `X-CSRF-Token`, and
  `Idempotency-Key`.
- Browser-readable response headers include `X-Request-ID` and
  `Idempotency-Replayed`.
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

export type UploadResponse = {
  image: {
    id: string;
    format: "jpeg" | "png" | "tiff";
    byteSize: number;
    pageCount: number;
    sha256: string;
    uploadedAt: string;
  };
  submissions: Array<{
    id: string;
    pageIndex: number;
    width: number;
    height: number;
    status: "uploaded";
    imageUrl: string;
    previewUrl: string;
  }>;
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
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
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

export async function uploadImage(file: File, idempotencyKey: string): Promise<UploadResponse> {
  const form = new FormData();
  form.set("image", file);
  return apiRequest<UploadResponse>("/api/v1/submissions", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: form,
  });
}
```

This minimal wrapper assumes backend JSON for non-`204` responses. A production
frontend may add runtime schema validation and a dedicated network/CORS error
type. It must preserve credentials, CSRF replacement after login, and no unsafe
automatic retries. Generate one idempotency key with `crypto.randomUUID()` per
deliberate upload and retain it until that upload succeeds or is abandoned.

## Authorization

| Operation | Anonymous | `pathologist` | `admin` |
| --- | --- | --- | --- |
| Health checks | Allowed | Allowed | Allowed |
| Read session | Allowed | Allowed | Allowed |
| Login | Allowed | Allowed | Allowed |
| Logout | Denied | Allowed | Allowed |
| Upload image | Denied | Own records | Own records |
| Read submission/original/preview | Denied | Own records | Own records |
| Pathologist-only future route | Denied | Allowed | Denied |

Roles are exact, not hierarchical. `admin` does not inherit `pathologist`
permission. Image access is based on ownership rather than role; administrators
cannot read another user's images. No currently exposed product endpoint uses a
role guard, so do not infer additional role capabilities.

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
- Generate and retain one idempotency UUID for each deliberate upload. Reuse it
  only when retrying that same file.
- Treat every returned TIFF page as its own submission and keep `pageIndex`.
- Resolve `imageUrl` and `previewUrl` against `NEXT_PUBLIC_API_URL`. Use the
  preview for display; never use preview bytes as model input.
- Do not show signup, reset-password, prediction, history, or review as connected
  features until backend endpoints exist.
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
- `src/images/routes.ts`: upload, submission, ownership, idempotency, and file responses
- `src/images/storage.ts`: paths, limits, readiness, and reconciliation
- `tests/server.test.mjs`: health and not-found contract checks
- `tests/auth.test.mjs`: browser authentication and image-intake lifecycle checks

## Change Log

| Date | Backend commit | Change |
| --- | --- | --- |
| 2026-10-05 | Pending | Added private image intake and owner-scoped submission/original/preview endpoints |
| 2026-10-04 | `2eeb6ba` | Created frontend handoff for implemented health and authentication contracts |
