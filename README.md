<div align="center">

# MingoCell API

**Private image intake, authenticated workspaces, and durable cell-classification jobs.**

[![Backend CI](https://github.com/Mingotrees/Mingocell-api/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/Mingotrees/Mingocell-api/actions/workflows/deploy.yml)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square)

[Overview](#overview) · [Getting started](#getting-started) · [API](#api) · [Testing](#testing) · [Deployment](#deployment)

</div>

## Overview

MingoCell API is the Express 5 and TypeScript backend for the MingoCell research
workspace. It stores microscopy images privately, controls account access, and
coordinates inference through the separate [MingoCells classifier](https://github.com/noni-was-taken/MingoCells-classifier).

- **Session-based access:** PostgreSQL-backed sessions, CSRF protection, fixed expiry, and role checks.
- **Private image intake:** validated PNG/JPEG/TIFF uploads, immutable originals, page previews, and readable labels.
- **On-demand analysis:** one explicit Analyze request per image or TIFF page, with idempotent enqueue and saved results.
- **Durable execution:** a separate worker, bounded retries, crash recovery, and stale-attempt publication fences.
- **Prediction provenance:** calibrated probabilities, uncertainty, abstention, model identity, and input hashes.
- **Operational visibility:** health checks, request IDs, structured logs, and CI-tested deployment artifacts.

> [!NOTE]
> MingoCell provides image-level research decision support, not an AML diagnosis.
> An abstained prediction is a valid result requiring expert review, not a failed job.

### How the services fit together

```text
Browser → Express API → PostgreSQL: accounts, sessions, submissions, jobs, results
                 └──→ Private storage: originals and previews
                              ↓
                      Classification worker → Flask classifier
```

The [frontend](https://github.com/Mingotrees/Mingocellfront) uploads images, then
requests analysis of a selected submission. The API acknowledges queued work
without waiting for inference; the browser polls for its saved result. Uploading
alone never starts classification. Browser code never receives the classifier token.

## Getting started

### Prerequisites

- **Node.js 24+** and npm; CI uses Node.js 24.
- A **POSIX environment** (Linux/macOS, or WSL on Windows) for shell scripts and private-file permissions.
- **PostgreSQL**, with an existing development database and a role allowed to create schemas/tables. CI uses PostgreSQL 16.
- For analysis: a running classifier, its private service configuration, and a
  **Python environment with Pillow 13.0.0** for TIFF-page extraction.

### 1. Install and configure

```bash
git clone https://github.com/Mingotrees/Mingocell-api.git
cd Mingocell-api
npm ci
cp .env.example .env
```

Edit `.env` with your development `DB_*` settings and a `SESSION_SECRET` of at
least 32 characters. Generate a local secret with `openssl rand -hex 32`; keep
the value private. See [`.env.example`](.env.example) for configuration defaults.

### 2. Initialize and start

```bash
npm run build
npm run migrate
npm run account -- create researcher@example.org pathologist
npm run dev
```

The account command prompts for a password twice without echoing it. Passwords
must contain 12–128 characters. `npm run dev` builds and starts the API at
`http://127.0.0.1:20282`; restart it after source changes.

```bash
curl --fail http://127.0.0.1:20282/health/live
curl --fail http://127.0.0.1:20282/health/ready
```

> [!TIP]
> Use the same hostname for local frontend and API requests, such as
> `localhost:3000` and `localhost:20282`, so SameSite cookies work correctly.
> `npm run dev` enables local HTTP cookies; `npm start` uses secure production cookies.

### 3. Enable the analysis worker

Set these overrides in the API's private `.env` when using a local classifier:

```dotenv
IMAGE_STORAGE_ROOT=/absolute/path/to/Mingocell-api/storage
CLASSIFIER_URL=http://127.0.0.1:20301
CLASSIFIER_CONFIG_PATH=/absolute/private/classifier-runtime/server.json
CLASSIFIER_PYTHON=/absolute/path/to/classifier/.venv/bin/python
```

The worker reads the existing `service_token` and timeout from `server.json`.
That file must be owned by the runtime user, non-symlinked, and private (`0600`).
Keep it outside the public web root and repository.
Use the same absolute storage root for the API and worker, and restart the API
after changing `.env`; `npm run worker` uses production-mode storage defaults.

In another terminal, run:

```bash
npm run worker
```

The worker processes one inference at a time. At the default classifier timeout,
startup includes a deliberate 210-second recovery window before dispatching work.
See the [integration runbook](docs/CLASSIFIER_INTEGRATION.md) for retries, suspension,
decoder requirements, and deployment recovery.

### Configuration at a glance

| Setting | Purpose / default |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Required PostgreSQL connection settings |
| `SESSION_SECRET` | Required session-signing secret, at least 32 characters |
| `HOST`, `PORT` | HTTP binding; `127.0.0.1:20282` by default |
| `CORS_ORIGINS` | Exact browser origins; defaults include production frontend and `http://localhost:3000` |
| `TRUST_LOCAL_HTTPS_PROXY` | `false` locally; DCISM uses `true` with loopback binding |
| `IMAGE_STORAGE_ROOT` | Local `storage/`; production defaults to private DCISM storage |
| `IMAGE_OWNER_QUOTA_BYTES` | Original-image quota; 5 GiB per owner |
| `IMAGE_MIN_FREE_BYTES` | Free-space reserve; 1 GiB |
| `CLASSIFIER_URL`, `CLASSIFIER_CONFIG_PATH`, `CLASSIFIER_PYTHON` | Worker connection, private settings, and decoder interpreter |

## API

Production API target: **https://api-mingocell.dcism.org**.
Full request/response schemas, errors, pagination, and examples live in
[`FRONTEND_API.md`](FRONTEND_API.md).

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | Database and private-storage readiness |
| GET | `/api/v1/auth/session` | Restore/bootstrap session and obtain CSRF token |
| POST | `/api/v1/auth/login` | Sign in and rotate session/CSRF state |
| POST | `/api/v1/auth/logout` | End current browser session |
| POST | `/api/v1/submissions` | Upload one image using multipart field `image` |
| GET | `/api/v1/submissions` | Owner-only, paginated submission history |
| GET | `/api/v1/submissions/:id` | Submission metadata |
| GET | `/api/v1/submissions/:id/image` | Download immutable original |
| GET | `/api/v1/submissions/:id/preview` | Retrieve browser preview |
| POST | `/api/v1/submissions/:id/analysis` | Enqueue selected image/page; pathologist or admin role required |
| GET | `/api/v1/submissions/:id/analysis` | Retrieve job state and result |
| GET | `/api/v1/submissions/:id/reviews` | Owned, paginated expert-review history |
| POST | `/api/v1/submissions/:id/reviews` | Append expert decision; admin or pathologist, owned referred result |

Browser requests use `credentials: 'include'`. Bootstrap the session first, then
send its latest `X-CSRF-Token` on writes with an allowed `Origin`. Uploads also
require an `Idempotency-Key`; preserve it when retrying the same file.

Analysis returns **202** while queued/running and **200** for an existing terminal
outcome. Repeated Analyze requests reuse the job/result. Job states are `queued`,
`running`, `succeeded`, and `failed`; before enqueue, GET reports `not_requested`.
Poll only the selected active job, initially every 15 seconds, and back off on errors.

> [!IMPORTANT]
> API readiness checks the database and storage, not classifier availability.
> Expert-review storage requires migration `006_expert_reviews.sql`. Decisions
> are separate append-only records; original classifier output is never overwritten.

### Expert decisions

Both roles can review their own completed, model-referred submissions. `Confirmed`
retains the original stage, `Reclassified` assigns another of the six stage codes,
and `Unresolved` assigns no expert stage. The server records reviewer ID, email,
role, timestamp, and sequential revision. Notes are limited to 2000 characters.

Writes require a UUID `Idempotency-Key` and the latest `previousReviewId` (or null
for the first decision). Retry uncertain delivery with the same key and body.
Stale reviews return `409 REVIEW_CONFLICT`; refresh history before appending a new
decision. Database triggers reject updates, deletes, and truncation of review rows.
Reads return newest-first pages, using `limit` and `before` revision parameters.

### Image and queue limits

| Limit | Value |
| --- | --- |
| Accepted uploads | PNG, JPEG, TIFF; one isolated cell per image/page |
| Original file size | 5 MiB |
| Decoded pixels | 4 million per page; 20 million per file |
| TIFF pages | Up to 20; each becomes a separate submission |
| Active analysis jobs | 100 globally; 20 per owner |
| Automatic attempt budget | Up to 3 total attempts |

Originals and per-page JPEG previews are stored separately outside the public web
root. Inference uses original bytes or losslessly extracted TIFF pages, never
previews. Startup reconciles old temporary/orphaned files; original images have
no automatic expiry. Back up private storage separately from deployment.

### Account administration

```bash
npm run account -- create admin@example.org admin
npm run account -- reset-password researcher@example.org
npm run account -- deactivate researcher@example.org
```

There is no public signup or browser account-administration page. Both `admin`
and `pathologist` can request analysis of their own submissions; roles otherwise
remain explicit rather than hierarchical. Password reset and deactivation revoke
active sessions; normal sessions expire after 8 hours, or 7 days with remember-me.

## Testing

```bash
npm test
```

This builds TypeScript and runs available checks. For the full database/decoder
suite, use a **fresh, disposable database named `mingocell_test`** and a Pillow
13.0.0 environment:

```bash
export TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/mingocell_test
export CLASSIFIER_PYTHON=/absolute/path/to/pillow-venv/bin/python
npm test
python3 tests/account-cli.py
"$CLASSIFIER_PYTHON" tests/classifier-input.py
```

Integration tests create their schema and require a fresh database for each full
run. They skip without `TEST_DATABASE_URL`; the Node decoder check skips without
`CLASSIFIER_PYTHON`. CI supplies both and also runs workflow lint and runtime-artifact
checks. Coverage includes ownership/CSRF, upload replay, queue admission, retries,
lease fencing, shutdown, TIFF equivalence, secret redaction, and deployment ordering.

## Deployment

The [GitHub Actions workflow](.github/workflows/deploy.yml) runs **Backend CI** on
branch pushes, PRs to `main`, and manual runs. Main-only deployment requires CI
success and downloads that run's tested runtime artifact instead of rebuilding.
PR checks do not receive deployment credentials.

DCISM runs `mingocell-api` and `mingocell-classification-worker` under PM2. Deployment
preflights the classifier, drains the old worker, replaces compiled code, applies
additive migrations, restarts services, and checks fresh worker/API readiness.
Private `.env`, storage, and classifier configuration remain outside artifacts.

For first-time server setup, configure the production database/private `.env`,
build and migrate, then register the API with
`pm2 start npm --name mingocell-api -- start`. DCISM requires
`HOST=127.0.0.1` and `TRUST_LOCAL_HTTPS_PROXY=true` for its local TLS proxy.
The classifier and its private runtime configuration must already be available.

Configure repository Actions secrets `DCISM_SSH_KEY`, `DCISM_KNOWN_HOSTS`,
`DCISM_HOST`, `DCISM_PORT`, `DCISM_USER`, and `DCISM_DEPLOY_PATH`. The
[workflow](.github/workflows/deploy.yml) pins the expected destination; update its
assertions as well as secrets when changing hosts or paths.

Use the [integration runbook](docs/CLASSIFIER_INTEGRATION.md) for exact server paths,
worker checks, timeouts, and rollback. Operational logs
are structured JSON; correlate failures using `X-Request-ID` and PM2 logs.

## Project layout

```text
src/auth/          Sessions, CSRF, roles, passwords, and account management
src/images/        Upload validation, private storage, labels, and history
src/analysis/      Classifier client, queue repository, input decoding, and worker
src/database/      PostgreSQL pool and transactional migration runner
src/cli/           Account, migration, and classification-worker entry points
migrations/        Append-only, checksummed SQL migrations
scripts/           TIFF extraction and allowlisted runtime packaging
deploy/            Worker PM2 configuration and operational checks
tests/             HTTP, database, decoder, packaging, and deployment regressions
```

Related projects: [frontend workspace](https://github.com/Mingotrees/Mingocellfront) ·
[classifier service](https://github.com/noni-was-taken/MingoCells-classifier) ·
[canonical research package](https://github.com/Mingotrees/MingoCells).
