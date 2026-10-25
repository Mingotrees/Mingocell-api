# On-demand classifier integration

## User flow

Upload stores the immutable original and creates one submission per image/TIFF page.
Click **Analyze** on one image to queue only that submission. The API returns 202
promptly, a background worker classifies it, and the browser polls the selected
analysis every 15 seconds. Results survive navigation and reload at
`/predictions/detail/?submission=<uuid>`. History and Review Cases browse saved
backend records. On completed, referred analyses, admins and pathologists can
append expert decisions through `/api/v1/submissions/:id/reviews` after migration
`006_expert_reviews.sql`. Expert decisions preserve the original classifier output.

## API

`POST /api/v1/submissions/:id/analysis` requires owner session, pathologist or admin
role, allowed Origin and X-CSRF-Token. No file body is needed. Both roles can
analyze only their own submissions. Repeating POST returns the same job: 202 queued/running,
200 succeeded/failed. Successful results are immutable in this increment.

`GET /api/v1/submissions/:id/analysis` requires authenticated ownership. Returns
`{analysis:{state:"not_requested",submissionId}}` before enqueue, otherwise
`{analysis:{id,submissionId,state,attempts,createdAt,startedAt,finishedAt,statusUrl,
retryable,error,result}}`. Result contains classifier `prediction` unchanged after
validation, plus `provenance` with original/input SHA-256, page index, decoder
version and model/policy metadata. See `src/analysis/types.ts` for complete schema.

Unknown/unowned submissions return 404; unauthenticated 401; role/CSRF failures 403.
Queue full is 429 `ANALYSIS_QUEUE_FULL`, `Retry-After: 30`. Limits: 100 active jobs
globally, 20 per owner, checked atomically. Duplicate requests bypass capacity
checks because they do not add work. Overall API request limits still apply.

## Worker configuration

Classifier and API run under the same hosting account. Worker reads existing private
classifier settings; no service-token copy is needed.

Optional backend `.env` settings (paths/URL only, never token):

```dotenv
CLASSIFIER_URL=http://127.0.0.1:20301
CLASSIFIER_CONFIG_PATH=/data/users/s22101440/mingocell-classifier-runtime/server.json
CLASSIFIER_PYTHON=/data/users/s22101440/mingocell-classifier-runtime/current/.venv/bin/python
```

`server.json` must be a regular non-symlink file, owned by runtime user, with no
group/world permissions. Token must match classifier contract. Timeout is positive
integer seconds, default 120, maximum 3600 to bound worker shutdown/lease arithmetic.
Keep classifier at one Gunicorn synchronous worker; do not add model processes.
URL must use numeric loopback HTTP. Secrets never enter arguments, browser settings,
application logs, or ecosystem definition. Use existing `DB_*` and storage settings.

```bash
npm run build
npm run migrate
node --env-file-if-exists=.env deploy/check-analysis-worker.mjs --preflight
pm2 startOrRestart deploy/ecosystem.config.cjs --update-env
node --env-file-if-exists=.env deploy/check-analysis-worker.mjs
```

`npm run worker` runs foreground worker for diagnosis. PM2 name:
`mingocell-classification-worker`. Exactly one fork; session advisory lock also
prevents duplicate consumers. Preflight checks authenticated classifier readiness,
metadata, and installed Pillow 13.0.0, without model inference. Runtime check also
requires worker heartbeat less than 30 seconds old and state ready/recovering.

## Timing, retries and recovery

At default classifier timeout 120 seconds:

| Setting | Value |
|---|---|
| Classify HTTP timeout | 150 seconds |
| Readiness/metadata HTTP timeout | 10 seconds each |
| TIFF helper timeout | 30 seconds |
| Lease / restart safety margin | 210 seconds |
| Worker heartbeat / lease renewal | 10 seconds |
| Idle queue poll | 2 seconds |
| Suspend health reprobe | 60 seconds after failed probe |
| PM2 graceful kill timeout | 210 seconds |
| Initial automatic retry delays | 30 seconds, then 120 seconds |

Every worker startup deliberately waits at least timeout +90 seconds, including
first deployment. Uncertain HTTP can continue in Python after Node disconnects.
Persisted safe-after timestamps and expired leases can extend retry delay. This
conservative wait avoids immediate duplicate dispatch; it is not cancellation.
Gunicorn's one worker is the final inference serialization boundary.

Three total inference attempts maximum. Transient failures requeue automatically;
invalid input is permanent. Exhausted/permanent failures return saved error and
`retryable:false`. Explicit retry is supported only for a failure deliberately
marked retryable with remaining attempts; it never resets the counter. Current
automatic paths requeue directly, so ordinarily users need no manual retry button.

Auth/decoder configuration failure or identity mismatch suspends dispatch. Jobs are
not silently dropped. A failure before inference dispatch can restore that reserved
attempt. A dispatched request consumes its attempt even if response is lost.
Correct private configuration and restart worker if token/path/timeout changed:

```bash
pm2 describe mingocell-classification-worker
pm2 logs mingocell-classification-worker --lines 50
node --env-file-if-exists=.env deploy/check-analysis-worker.mjs --preflight
pm2 restart mingocell-classification-worker --update-env
```

Do not reset job counters or edit JSON results manually. An expired running attempt
recovers as delayed queued work, or terminal failure when budget is exhausted.
Attempt UUID + worker instance fence stale publication. Result publication and
submission `analyzed` status update share one short transaction. No transaction
remains open during image extraction or HTTP. Computation is at-least-once, not
exactly-once. A worker that loses its lock connection exits instead of publishing
through a fresh database connection.

## Input and provenance

Single-frame originals pass through unchanged. Multipage TIFF selects exact
zero-based `page_index`, applies Pillow EXIF/RGB conversion, and emits a lossless,
metadata-free RGB PNG. Never use JPEG previews, resize, white-flatten transparency,
or normalize high bit depth differently from canonical loader. Decoder helper imports
Pillow only; it does not load models or Torch. Resolve release directory once per
extraction so virtualenv Python retains its installed packages.

Limits: 5 MiB original, 4 million selected-page pixels, 20 TIFF frames, 30-second
helper, 9 MiB PNG output, 4 KiB decoder metadata. A valid stored TIFF page may expand
past 9 MiB; return permanent `CLASSIFIER_INPUT_TOO_LARGE` rather than downsample.
This leaves framing margin under Flask's 10 MiB total request limit.

Classifier source pin checked: `b019123d6c40b3088ed3675d16e8c9f08b66f7ce`.
Installed release decoder: Pillow 13.0.0. Pixel fixtures exercise distinct frames,
RGB/RGBA/palette/CMYK, 16-bit grayscale and orientation. Run equivalence checks:

```bash
CLASSIFIER_PYTHON=/absolute/classifier/.venv/bin/python npm test
/absolute/classifier/.venv/bin/python tests/classifier-input.py
REQUIRE_CANONICAL_LOADER=1 /absolute/classifier/.venv/bin/python tests/classifier-input.py
```

Last command additionally decodes output through installed pinned `myeloid` loader;
it needs that private package, not model artifacts. CI installs pinned Pillow and
runs Node/Python fixtures; it does not download models. PostgreSQL integration tests
also require disposable `mingocell_test` database via TEST_DATABASE_URL; existing
harness initializes schema, so use fresh database for every full run.

## Deployment and rollback

### Required CI check

`Backend CI` runs on branch pushes, PRs targeting main, and manual runs. It runs
Node24/PostgreSQL16 tests, Python3.13/Pillow13 decoder fixtures, hidden-password CLI
checks, workflow lint, and runtime-artifact packaging. CI explicitly requires the
database URL and decoder interpreter so integration suites are not silently skipped.
No production database, service token or model bundle is used.

`npm run package:runtime -- <new-directory>` packages only compiled dist, migrations,
the TIFF helper, worker deployment scripts and package manifests. Missing required
files or symlinks fail packaging; .env, uploaded storage, tests and unrelated scripts
are excluded. The directory must not exist, preventing stale artifact reuse. CI
retains `backend-runtime-<sha>` for three days. The separate main-only deploy job
requires CI success and downloads that same-run artifact; it does not rebuild.

Main protection must require **Backend CI** from GitHub Actions and an up-to-date PR,
including administrators, with no force pushes/deletion. Investigate failures in the
CI job before rerunning; never bypass checks to test a patch in production. Dependency
updates should change package manifest/lock together and pass the complete disposable
database/decoder test commands above. Classifier main currently needs its owner to
require the existing `package` check; current API/frontend account has no admin access
there. Settings enforcement must be verified through GitHub, not inferred from YAML.

Feature branch pushes run tests only; main deploys automatically after merge.
New backend workflow stages dist/scripts/config/migrations in private
`.classifier-analysis-stage`, runs classifier/decoder preflight, then drains old
worker before replacing live compiled files. It migrates before starting new API
and worker. Fresh instance/heartbeat checks reject a stale prior worker. Recovering
state is acceptable during the deliberate startup cooldown; suspended is not.

Do not merge until classifier deployment and private configuration are available.
If deployment fails after worker stop, uploads/API may remain usable but analyses
wait. Inspect safe workflow logs, fix installation/config, then restart worker and
run readiness check. PM2 snapshots may contain private environment settings: do not
paste raw `pm2 env`, environment dumps, or configuration contents into reports.

Rollback: stop worker, restore previously verified compatible backend dist,
package manifests, helper and deploy scripts, install that release's dependencies,
then restart API/worker and verify fresh heartbeat. Keep additive migration 005 and
persisted jobs/results. Do not roll back database schema or erase queued jobs.
If restoring a backend revision predating worker support, keep worker stopped and
tell users processing is paused until forward recovery.

## Verification evidence and acceptance

Local checks: PostgreSQL-backed enqueue/concurrency, capacity, owner/role/CSRF,
retry/fencing/recovery, lost database connection, multipart HTTP, policy mismatch,
abstention, canonical decoder, and frontend controller/build tests.
Review regressions cover lease renewal overlapping both success and failure (including
an already in-flight renewal), terminal/visibility polling, lossless PNG expansion
over 9 MiB with zero inference dispatches, replacement-worker uncertainty deadlines,
and execution of deployment shell in disposable stop/transfer/migrate/start fixtures.
Local real-browser flow used Express + PostgreSQL + worker + fake classifier:
two-page TIFF uploaded, only page 2 analyzed, saved result/provenance verified,
refresh restored result, session deactivation redirected to login, preview decoded,
390-pixel mobile view had no horizontal overflow. Axe 4.10.2 WCAG-tagged audit of
live result page reported zero violations. Synthetic fake result proves integration,
not real-model accuracy. Original kit axe wrapper could not load Playwright; audit
was performed directly with installed browser runner and pinned axe CDN instead.

Production representative-image inference remains an external acceptance step,
requiring authorized deployment and interactive user sign-in. Check actual model
identity, original/page provenance, eventual result and refresh recovery. Record
observed latency; do not describe synthetic/browser results as scientific accuracy
or shared-host capacity evidence.
