# Per-image Classifier Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analyze one uploaded submission on demand, persist its real classifier result, and display it through the deployed browser flow.

**Architecture:** Express creates an idempotent PostgreSQL job; a singleton Node worker calls the synchronous local Flask service and publishes a fenced result. TIFF page extraction uses the classifier release's Pillow environment. A statically exported Next.js client polls only the selected submission.

**Tech Stack:** Node.js >=24, TypeScript/Express 5, node-postgres, PostgreSQL 16 CI, Python 3.13/Pillow from classifier release, PM2, Next.js static export/React, existing Node test runners.

**Spec:** `docs/superpowers/specs/2026-10-25-classifier-integration-design.md`

## Global Constraints

- Upload stores images only. Analyze acts on one individual submission/TIFF page.
- Start with one inference at a time. No transaction during extraction or HTTP.
- One job per submission; successful results immutable; at-least-once computation.
- Queue bounds: 100 globally active jobs and 20 per owner. Three total attempts; transient retry delays 30 then 120 seconds.
- Existing submission statuses remain `uploaded`, `analyzed`, `failed`; job states are `queued`, `running`, `succeeded`, `failed`.
- Enqueue requires active authenticated owner, CSRF/origin validation, and `pathologist` role. Admin does not inherit that role.
- Token comes from private classifier `server.json`; never frontend, arguments, logs, or source control.
- Canonical RGB semantics, not resized/flattened JPEG previews. Preserve calibrated probabilities and abstention.
- Poll selected job every 15 seconds initially, back off on errors, pause hidden tabs.
- Preserve existing local filename/label edits, migration 004, and authentication tests.
- No commits, pushes, production database changes, or deployments without explicit authorization. Task checkpoints mean local diff review, not implicit commits.
- Run backend commands from `Mingocell-api`; frontend commands from `../Mingocellfront`. Do not create worktrees that omit uncommitted baseline work; execution must preserve that baseline explicitly.

## Review Focus

1. Lost POST response/double click: same submission must resolve to one existing job, without another upload (Tasks 1, 5).
2. Database connection loss during HTTP: old worker cannot publish; replacement waits out uncertain inference (Task 4).
3. Valid uploaded TIFF page produces PNG larger than Flask's 10 MiB multipart limit: safe permanent failure, never preview fallback (Task 3).
4. Owner switches/logout while a poll resolves: no old-owner result flash or continuing requests (Task 5).
5. Classifier upgrades during prediction: mismatched policy/package must not publish a plausible-looking result (Tasks 2, 4).

## File map and interfaces

Backend additions: `src/analysis/{types,config,repository,routes,classifier,input,worker}.ts`,
`src/cli/classification-worker.ts`, `scripts/extract-classifier-page.py`,
`deploy/ecosystem.config.cjs`, `deploy/check-analysis-worker.mjs`,
`migrations/005_classification_jobs.sql`, `docs/CLASSIFIER_INTEGRATION.md`.
Files may split only if responsibility actually grows; do not restructure image intake.

Tests: unit/transport tests in `tests/analysis-{classifier,input,config}.test.mjs`;
shared-database tests in `tests/analysis-integration.mjs`, invoked by the existing
`tests/auth.test.mjs` integration harness to avoid parallel schema initialization.
Python decoder tests in `tests/classifier-input.py`. Add meaningful browser verification
during Task 5 using the browser skill, rather than duplicating implementation assertions.

Frontend additions: `lib/analysis-api.ts`, `features/predictions/analysis-controller.ts`,
`features/predictions/live-analysis.tsx`, `features/predictions/live-result.tsx`,
`tests/analysis.test.ts`. Modify upload card and detail query only for live wiring.

`types.ts` owns backend types (no runtime database import):
- `AnalysisState = "queued" | "running" | "succeeded" | "failed"`.
- `Prediction` exactly mirrors classifier response fields from spec; `ModelMetadata`
  mirrors `/api/model` including temperature, threshold, architecture order, device.
- `Provenance`: original/input SHA-256, page index, extraction version, Pillow version
  (null when original bytes pass through), metadata, analysis timestamp.
- `AnalysisView`: id, submissionId, state, attempts, createdAt, startedAt, finishedAt,
  statusUrl, retryable, error (`{code,message}` or null), result (`{prediction,provenance}` or null).
- `AnalysisResponse = { analysis: AnalysisView | { state: "not_requested"; submissionId: string } }`.
- `Claim`: jobId, submissionId, attemptId, attempts, originalStorageKey, originalSha256,
  format, pageIndex, pageCount, width, height. Backend paths never enter public view.
- `AnalysisFailure`: typed safe code, classification (`permanent`, `transient`, `suspend`),
  and uncertain-dispatch flag; raw HTTP bodies/exceptions stay out of public/log fields.

## Task 1: Durable queue, admission, and authenticated routes

**Files:** create `types.ts`, `repository.ts`, `routes.ts`, migration 005,
`tests/analysis-integration.mjs`; modify `src/app.ts`, `tests/auth.test.mjs`, `FRONTEND_API.md`.

**Interfaces:** `enqueueAnalysis(pool: Pool, submissionId: string, ownerId: string): Promise<{analysis: AnalysisView; created: boolean}>`;
`getAnalysis(pool: Pool, submissionId: string, ownerId: string): Promise<AnalysisResponse>`;
`mountAnalysisRoutes(app: Express, pool: Pool): void`. App mounts after auth/image routes
when image storage exists, reusing `imageStorage.pool` without changing current call sites.

- [ ] Write failing integration cases inside existing isolated `mingocell_test` lifecycle: owner upload has `not_requested`; first POST returns 202; 10 concurrent POSTs return one job ID; owner GET succeeds; other owner/malformed UUID returns 404; anonymous 401; admin enqueue 403; missing CSRF 403. Test no job is created by upload alone.
- [ ] Run `npm run build && node --test tests/auth.test.mjs` with `TEST_DATABASE_URL` pointing to a fresh isolated `mingocell_test` database. Confirm new route tests fail for missing functionality, not unavailable database. Existing harness creates shared schema; do not start another parallel migrator. Reset only disposable test database between runs.
- [ ] Implement additive migration: unique submission FK, checked states, attempts 0..3, attempt UUID, availability/lease/dispatch times, errors/result/provenance and timestamps; due-job partial index; singleton `classification_worker` control row (instance UUID, heartbeat, state, safe-after, safe error). Constraint: succeeded iff result exists; running requires attempt UUID/lease. Do not alter already checksummed migrations. Update existing migration-count assertion from 4 to 5 and assert previous records survive.
- [ ] Implement admission in short transaction using shared advisory transaction lock, owner lookup, existing-job lookup before count checks, parameterized SQL, and capacities 100/20. Return immutable succeeded result with 200; pending with 202. Failed permanent/exhausted stays failed (200). A retryable failed job with attempts <3 may requeue without resetting attempts, subject to capacity. Safe 429 `ANALYSIS_QUEUE_FULL`, `Retry-After: 30`. Do not expose worker state internals in these errors.
- [ ] Extend integration cases: limits enforced across concurrent users; duplicate at full capacity still returns existing job; successful POST reuse 200; permanent/exhausted failure is not requeued; manual eligible retry preserves counter. Test route result shape matches `AnalysisResponse` and never contains storage key/token.
- [ ] Run focused tests with database enabled and existing unit suite `npm test`; confirm integration cases execute (not skipped). Record local diff checkpoint. Update `FRONTEND_API.md` with exact route/status/error contract and per-image behavior, retaining pre-existing edits.

## Task 2: Private configuration and validated classifier transport

**Files:** create `config.ts`, `classifier.ts`, `tests/analysis-config.test.mjs`,
`tests/analysis-classifier.test.mjs`; extend types as declared above.

**Interfaces:** `loadClassifierConfig(environment: NodeJS.ProcessEnv): Promise<ClassifierConfig>`;
`ClassifierConfig = {baseUrl: string; token: string; serviceTimeoutMs: number; pythonPath: string}`;
`ClassifierClient` methods `ready(signal: AbortSignal): Promise<void>`,
`model(signal: AbortSignal): Promise<ModelMetadata>`,
`classify(input: {bytes: Uint8Array; filename: string; mediaType: string}, signal: AbortSignal): Promise<Prediction>`.
Factory `createClassifierClient(config: ClassifierConfig, fetchImpl?: typeof fetch): ClassifierClient`.
`validatePrediction(value: unknown, model: ModelMetadata): Prediction` is pure and exported.

- [ ] Write unit/config and real local HTTP fake-server cases: protected config file accepted, group/world readable/symlink/wrong owner rejected, malformed token/timeout rejected, actual multipart field named `image`, Bearer header present only on fixed loopback target, no redirect following, 401/403 suspended, 400/413 permanent, 5xx/network transient, oversized/non-JSON body rejected. Use generated test-only tokens; assert logs/errors do not contain them.
- [ ] Run `npm run build && node --test tests/analysis-config.test.mjs tests/analysis-classifier.test.mjs`; confirm missing exports fail first.
- [ ] Implement defaults: `CLASSIFIER_CONFIG_PATH=/data/users/s22101440/mingocell-classifier-runtime/server.json`, `CLASSIFIER_URL=http://127.0.0.1:20301`, `CLASSIFIER_PYTHON=/data/users/s22101440/mingocell-classifier-runtime/current/.venv/bin/python`. Require loopback HTTP, no credentials/query/fragment, config regular non-symlink owned file with no group/world permission, token pattern `[A-Za-z0-9_-]{32,}`, positive integer timeout. Open/fstat safely to avoid validating a different file than read. Token is held only in worker memory. API process does not need classifier config to serve uploads/status.
- [ ] Implement bounded fetch with `redirect: "error"`; cap JSON bodies at 64 KiB while reading. Metadata calls have 10-second timeout; classify has service timeout +30 seconds. Validate schema version 1 and expected class order from classifier's pinned manifest, finite [0,1] values, probability sum tolerance 1e-6, argmax with first-max tie policy, confidence tolerance 1e-6, entropy recomputation tolerance 1e-6, abstention `entropy > threshold`, package version positive integer. Validate metadata fields rather than casting unknown JSON. HTTP failure after dispatch is uncertain until cooldown elapsed.
- [ ] Add cases for NaN-equivalent invalid values/null, probability/class mismatch, reordered classes, entropy/confidence disagreement, valid abstention, and same ID with changed policy metadata. Pre/post metadata match uses full validated identity/policy (not object key order). Run focused tests again and record checkpoint.

## Task 3: Original-byte and canonical TIFF page input

**Files:** create `input.ts`, `scripts/extract-classifier-page.py`,
`tests/analysis-input.test.mjs`, `tests/classifier-input.py`; create decoder fixture data
under `tests/fixtures/classifier-input/` only if fixtures cannot be generated in tests.

**Interfaces:** `prepareClassifierInput(claim: Claim, storage: ImageStorageOptions, config: ClassifierConfig, signal: AbortSignal): Promise<PreparedInput>`;
`PreparedInput = {bytes: Uint8Array; filename: string; mediaType: string; sha256: string; extractionVersion: string; pillowVersion: string | null}`.
Helper reads original bytes on stdin; arguments only page index and trusted limits;
outputs PNG bytes on stdout and a small JSON decoder/version record on stderr upon
success. Error output is mapped to safe codes; never logged verbatim.

- [ ] First verify authoritative loader at dependency revision `b019123d6c40b3088ed3675d16e8c9f08b66f7ce` from `../MingoCells-classifier/config/dependency-source.json`, using installed release environment or exact revision checkout. Record decoder version/verification procedure. Local research checkout alone is not proof of that revision.
- [ ] Write tests: single-frame JPEG/PNG/TIFF bytes unchanged; original hash mismatch rejected; page 1 of two distinct TIFF frames yields page 1 pixels; oriented TIFF is not double-rotated; transparency/palette and 16-bit grayscale match canonical per-frame RGB conversion; unsupported/corrupt/out-of-range pages fail permanently. Assert preview path never read.
- [ ] Run `npm run build && node --test tests/analysis-input.test.mjs` and `"$CLASSIFIER_PYTHON" tests/classifier-input.py`; confirm helper is missing before implementing. Tests need Pillow, not Torch models; pinned-loader cross-check runs in actual installed dependency environment and must not be silently skipped in acceptance.
- [ ] Implement safe O_NOFOLLOW original open and SHA-256 verification; single-frame originals pass through. For multipage TIFF use `spawn` without shell, resolve current release realpath once per extraction, Pillow `seek(pageIndex)` then canonical EXIF/RGB policy, strip metadata, save lossless PNG. Bound helper to 30 seconds, 4,000,000 selected-page pixels, 5 MiB input, 9 MiB PNG plus <=4 KiB metadata; require complete successful child exit. Nine MiB leaves room for multipart framing below Flask's 10 MiB total-request cap. Oversized lossless input gets permanent `CLASSIFIER_INPUT_TOO_LARGE`, never resize/fallback.
- [ ] Keep helper memory-bounded by byte/pixel limits; close stdin/kill child on abort; no persistent extracted files (bounded pipes remove orphan cleanup need). Verify serialized RGB PNG is decoded identically by canonical loader. Helper must not import classifier runtime/Torch. Version provenance `pillow-page-rgb-v1` or `original-bytes-v1`.
- [ ] Add abort, helper missing, oversized stdout, nonzero exit, original tampering, and metadata overflow tests. Missing interpreter/dependency suspends worker; invalid image/input-too-large is permanent. Run Node/Python checks and record checkpoint; block TIFF support if equivalence cannot be proven.

## Task 4: Fenced singleton worker and restart recovery

**Files:** create `worker.ts`, `src/cli/classification-worker.ts`; extend `repository.ts`,
`tests/analysis-integration.mjs`; modify `package.json` to add `worker` script.

**Interfaces:** `runClassificationWorker({pool,storage,config,client,signal,log}: WorkerOptions): Promise<void>`;
`claimNext(client: PoolClient, instanceId: string, leaseMs: number): Promise<Claim | null>`;
`renewAttempt(client: PoolClient, claim: Claim, instanceId: string, leaseMs: number): Promise<boolean>`;
`finishAttempt(client: PoolClient, claim: Claim, instanceId: string, result: {prediction: Prediction; provenance: Provenance}): Promise<boolean>`;
`failAttempt(client: PoolClient, claim: Claim, instanceId: string, failure: AnalysisFailure): Promise<void>`.
Worker owns checked-out lock client; all guarded state mutations use that same live
connection in short transactions. This prevents publishing through another pooled
connection after singleton lock loss. Pool remains available for independent API work.

- [ ] Write database/fake-HTTP tests: two worker instances yield one dispatch; available jobs selected in created-at/id order; callbacks use no open transaction during HTTP; startup after crashed running attempt waits safety deadline; expired attempts recover; stale UUID completion updates zero rows; lock-connection termination stops old worker publication even before another worker claims. Inject a clock/scheduler in `WorkerOptions` for timers; real PostgreSQL still owns persisted times and concurrency tests.
- [ ] Run existing shared integration harness with new cases; confirm worker imports/behavior fail before implementation.
- [ ] Implement singleton session advisory lock keyed `mingocell:classification-worker`, not transaction lock. On acquisition record new instance/heartbeat and state `recovering`; wait service timeout +90 seconds at every startup before dispatch, and respect any larger persisted `safe_after`. Conservative restart delay covers uncertain HTTP and is visible in runbook. Set attempt lease = service timeout +90 seconds, renew every 10 seconds; worker control heartbeat every 10 seconds (including idle/suspended). Idle poll 2 seconds. All mutations compare instanceId plus attemptId/running state. Claim transaction locks one due row; no HTTP in transaction.
- [ ] Before dispatch check readiness and capture metadata, prepare input, persist dispatch time/safe-after, then classify and re-read model metadata. Publish only fully validated stable result, original/input hashes and decoder provenance; atomically set submission analyzed. Start no later job while prior uncertain attempt still inside safety interval. On lease expiry recover using last heartbeat + service timeout +90 seconds (or later persisted safe-after). Gunicorn's one worker remains ultimate inference serialization.
- [ ] Implement retry decisions: transient attempts 1/2 return queued with +30/+120 seconds, uncertainty may extend these; exhausted attempt 3 is terminal failed and nonretryable. Permanent input fails immediately. Suspension records safe control error and keeps affected job queued with counter restored only when inference was never dispatched; dispatched attempts count. Reprobe every 60 seconds and resume only after readiness plus stable preflight metadata; service auth failure does not burn whole queue. No infinite retry budget reset. Disabled owners discovered before dispatch cause safe permanent failure without HTTP.
- [ ] Add shutdown behavior: signals stop claims, allow active bounded work then close lock connection/pool; second signal or deadline forces exit and lease recovery. On lock client `error`/`end`, abort local work and stop rather than reacquire in same instance. Define process grace = service timeout +90 seconds; transport/helper time fits bounded drain, otherwise recover. `npm run worker` uses existing .env loading pattern.
- [ ] Add tests for both retry delays/exhaustion, auth suspension/recovery without queue exhaustion, malformed output, changed pre/post metadata, valid abstention -> succeeded, atomic rollback, active owner deactivation, SIGTERM drain, forced death and recovery. Run focused integration tests then `npm test` and `python3 tests/account-cli.py` with isolated database. Record checkpoint.

## Task 5: Per-image Analyze and refreshable live results

**Files (frontend):** create `lib/analysis-api.ts`, `features/predictions/analysis-controller.ts`,
`live-analysis.tsx`, `live-result.tsx`, `tests/analysis.test.ts`; modify
`lib/submissions-api.ts`, `features/predictions/new-prediction.tsx`,
`features/predictions/detail-query.tsx`. Preserve existing sample result components.

**Interfaces:** frontend `AnalysisResponse`, `AnalysisView`, `Prediction` mirror documented
public contract with runtime validation; `createAnalysisClient(auth = authClient)`
returns `{request(submissionId: string, signal?: AbortSignal): Promise<AnalysisResponse>,
get(submissionId: string, signal?: AbortSignal): Promise<AnalysisResponse>}`.
Add `getSubmission(id: string, signal?: AbortSignal): Promise<SubmissionDetail>` to
submission API without altering upload behavior. `AnalysisController` exposes
`select(ownerId: string, submissionId: string): void`, `analyze(): Promise<void>`,
`setVisible(visible: boolean): void`, `dispose(): void`, `subscribe/getSnapshot`.
Use injected client/timers for deterministic scheduling tests; React adapter owns
auth expiry and visibility listeners, not the pure controller.

- [ ] Write failing client/controller tests: POST ID only/no file, cookie/CSRF preserved, lost POST resolves via GET with no repeated automatic POST, same-image double click suppressed, selection switch invalidates old promises, logout/dispose aborts and clears state, selected-job-only polls at 15 seconds, hidden/terminal stops polls, 401 expires session, 403 CSRF asks refresh, queue-full doesn't pretend queued. Invalid/mismatched submission IDs in responses rejected.
- [ ] Run `node --test tests/analysis.test.ts` from frontend; confirm missing module assertions fail first.
- [ ] Implement client using `authClient.authenticatedRequest` and URL-encoded validated UUID. Controller uses one timeout scheduled only after prior GET resolves; no overlapping polls. Network backoff 30/60/120 seconds; rate-limit backoff at least 60 seconds; successful active response restores 15 seconds. Clear/abort on owner change and guard response generation, including Analyze acknowledgement. No token in browser config. Existing wrapper lacks Retry-After exposure; fixed conservative backoff avoids unrelated API-wrapper refactor.
- [ ] Add Analyze per uploaded card for pathologists. Click selects submission and starts request, then navigates to `/predictions/detail/?submission=<uuid>`; pending request may be cancelled by navigation, so destination GET reconciles uncertain enqueue and offers Analyze if `not_requested`. Never automatically POST from mount/effect or restart a succeeded analysis. Provide View analysis link on every uploaded card; duplicate clicking may POST again but server uniqueness remains authoritative.
- [ ] Detail query branches on `submission` to live component; existing `id` continues sample component. Existing Suspense page boundary stays. Live component loads owned submission + analysis, renders idle/queued/running/error/succeeded states, offers eligible Analyze/Retry, and displays original preview (explicitly labeled preview), calibrated probabilities/confidence/entropy and actual abstention threshold/package metadata. Do not reuse sample threshold copy, illustrations, or expert-review save controls for live data. Label samples as samples. Render errors/access states with existing UI styles and accessible status announcements.
- [ ] Run `npm test` and `npm run build` in frontend; confirm static output contains `out/predictions/detail/index.html`, no live UUIDs needed at build time. Use browser verification with local API/fake classifier: upload two-frame TIFF, click page 2 Analyze only, observe one job and correct page provenance; refresh detail URL; expire session mid-poll; verify no sample result or other-owner result flash. Record evidence and local diff checkpoint.

## Task 6: Deployment lifecycle, CI, and operator runbook

**Files:** create `deploy/ecosystem.config.cjs`, `deploy/check-analysis-worker.mjs`,
`docs/CLASSIFIER_INTEGRATION.md`; modify `.github/workflows/deploy.yml`, `README.md`,
`FRONTEND_API.md`, backend package scripts if needed. Frontend uses its existing CI/deployment.

**Interfaces:** PM2 process `mingocell-classification-worker` runs compiled worker from
backend directory with production environment/.env, exactly one fork (no cluster).
`check-analysis-worker.mjs` loads private config without printing it, checks decoder
and authenticated model, and checks database control heartbeat <=30 seconds with
expected worker instance and state `recovering` or `ready` (not `suspended`). It
prints only safe status and package identity. It does not enqueue production work.

- [ ] Add CI checks that Python helper runs under a pinned Pillow version compatible
with classifier release (read actual version from packaged environment; record pin,
do not guess). Install Pillow only for helper tests; no model bundle/Torch required.
Run `python3 tests/classifier-input.py` plus existing backend/account tests. Execute
pinned canonical-loader cross-check separately where installed dependency exists.
CI syntax/lifecycle tests must fail if helper isn't transferred or worker stop follows
dist replacement. Use meaningful deploy contract test in `tests/analysis-deploy.test.mjs`
for artifact membership and ordered stop/migrate/start contract, not source snapshots.
- [ ] Implement deployment preflight verifying current classifier config/interpreter,
model readiness, PM2 capabilities and storage. Stop/drain existing analysis worker
before `rsync --delete` of dist; first deploy tolerates missing worker only. Transfer
Python helper and PM2/check scripts explicitly (current workflow transfers only
dist, package manifests, migrations). Migrate, restart API, then start/restart worker
with `kill_timeout` derived from configured timeout +90 seconds. Do not embed token
in PM2 args/env/ecosystem. Require fresh instance heartbeat from new worker, not old row.
- [ ] Add worker verification after existing API health checks, allowing recovering
cooldown without waiting for image inference. If deploy fails after stopping worker,
report that state and recovery command; do not silently claim healthy deployment.
Document how to stop worker, restore compatible dist/scripts/package release, keep
additive schema, and restart with fresh heartbeat. Never recreate classifier secrets.
- [ ] Run deploy contract tests, existing backend tests with PostgreSQL enabled,
`python3 tests/account-cli.py`, helper tests, workflow syntax/actionlint if installed,
and frontend `npm test && npm run build`. Record exact versions/results and skipped
external checks. Review intended diffs against dirty baseline in both repos.
- [ ] Write runbook: private config paths/permissions, operational timer values, queue
bounds, startup cooldown, input-too-large behavior, failed/retryable semantics,
worker heartbeat/readiness/PM2 commands, model-upgrade suspension and recovery,
rollback, decoder equivalence evidence, and bounded representative-image acceptance.
Update README and FRONTEND_API to link final contracts and distinguish implemented
features from future reviews/history. Self-review all spec requirements before final.
- [ ] After implementation, request one independent whole-change review if authorized
by chosen execution workflow; address blocking findings and rerun affected checks.
Report local verification, remaining external acceptance, and intended files. Do not
publish/deploy based on this plan alone.

## Authorized production acceptance (external gate)

Only after user explicitly authorizes deployment: deploy backend/worker then frontend;
sign in via interactive browser with user-entered credentials; upload representative
microscopy image, Analyze, observe immediate acknowledgement, eventual saved result
and matching package identity, refresh to recover; repeat two distinct TIFF pages.
Check safe worker logs and database provenance, not exposed credentials. Record actual
latency as observation, not accuracy/capacity claim. If remote access or representative
input is unavailable, state exact blocked check rather than reporting it passed.

## Self-review record

- Spec coverage: routes/admission (1), identity/config (2), input equivalence (3),
  durability/retries/shutdown (4), frontend (5), lifecycle/docs/acceptance (6).
- Review Focus cases assigned tests in named tasks; public types shared consistently.
- Key implementation calls: conservative restart cooldown, bounded helper pipes,
  nine-MiB PNG cap, query-string live detail route, safe fixed polling backoff.
- Checkpoints do not authorize commits or production changes. Both repos are needed
  for end-to-end behavior; backend persistence remains independently testable first.
- Existing dirty files must be incorporated, never replaced by a clean baseline.
