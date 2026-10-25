# Per-image asynchronous classifier integration

Date: 2026-10-25. Status: approved by user before implementation planning.

## Intent and agreed behavior

Connect the deployed classifier to the existing authenticated upload flow. Upload
stores images only. The user clicks Analyze on an individual submission, including
an individual TIFF page. The browser receives a prompt acknowledgement and polls
for a durable prediction, without holding an Apache request open during inference.

The user selected a separate worker backed by PostgreSQL. Implementation includes
backend routes, queue/result persistence, worker operation/deployment, and minimal
frontend Analyze/status/result wiring in sibling `Mingocellfront`. Existing sample
predictions must remain clearly distinguishable from live results.

No automatic analysis, batch-analysis action, model training, expert-review backend,
or classifier model/dependency changes are included. Do not present an abstention as
a failed request. Preserve unrelated working-tree changes. Do not commit, push, or
deploy without user authorization.

## Approaches considered

1. **Selected: PostgreSQL queue and separate Node worker.** Durable jobs use the
   existing database; web requests remain short; PM2 manages worker independently.
   Costs an extra process and explicit recovery/deployment logic.
2. Background execution in Express. Fewer process definitions, but couples worker
   availability and shutdown to the web server. Rejected in favor of isolation.

Synchronous browser-facing inference conflicts with the hosting administrator's
timeout guidance. Redis adds another service without a demonstrated need.

## Existing contracts and constraints

- `src/images/routes.ts` stores immutable originals and per-page JPEG previews.
  Submission identity includes a zero-based page index. Originals are shared by
  submissions from one TIFF. Previews are unsuitable classifier input.
- Existing submission statuses (`uploaded`, `analyzed`, `failed`) do not represent
  queue execution. Add separate durable job state.
- Flask at `http://127.0.0.1:20301` accepts authenticated multipart `image` at
  `/api/classify`. `/api/model` returns model/policy metadata. `/api/ready` loads
  and checks readiness. Preserve Bearer authentication even on shared loopback.
- Flask runs one synchronous Gunicorn worker; model runtime serializes prediction.
  Current server timeout defaults to 120 seconds, provisional rather than measured.
- API-wide rate limit currently permits 120 requests per 15 minutes per IP.
  Polling must fit that shared budget rather than using aggressive intervals.

## API and authorization (proposed defaults)

- `POST /api/v1/submissions/:id/analysis`: no uploaded bytes. Requires active
  authenticated owner, existing CSRF/origin checks, and `pathologist` role.
  Admin does not inherit pathologist permissions. Unknown/unowned IDs return 404.
- First enqueue returns 202 with `analysis` object and status URL. Repeated POST
  returns the same queued/running job (202), or completed result (200).
- `GET /api/v1/submissions/:id/analysis`: authenticated owner lookup; returns current
  job state/result or an explicit `not_requested` state. Admin owners can inspect
  their own records but cannot request inference.
- States: `queued`, `running`, `succeeded`, `failed`. Include stable job/submission
  IDs, timestamps, retry eligibility, and safe failure code/message. Never return
  credentials, storage paths, raw service exceptions, or request headers.
- An explicit subsequent Analyze request on a retryable terminal failure may
  requeue the same job, with a bounded total attempt budget. Permanent failure
  returns its existing failure. Successful results are immutable; no reanalysis
  against a newer model in this increment.
- At most one job per submission, enforced in the database. Initial admission
  bounds: 100 globally active jobs and 20 per owner. Serialize admission checks
  with a short transaction lock so concurrent requests cannot bypass limits.
  Duplicate requests do not consume capacity. Full queue returns 429 with retry
  guidance. These are implementer-proposed initial limits.

## Persistence and execution

Add migration after current migrations (including local filename migration).
Jobs record submission, execution state, attempt count, attempt UUID, availability
time, heartbeat/lease timestamps, safe errors, start/finish times, and result JSON.
Constraints enforce one job per submission and terminal/result consistency.
Store validated response, matching model metadata, original SHA-256, page index,
inference-input SHA-256, extraction version and decoder version as provenance.

Worker is a standalone Node entry point under PM2, with one execution loop. A
dedicated PostgreSQL connection holds a singleton session advisory lock; losing
that connection stops claims and prevents this instance publishing further work.
Claims and state transitions use short transactions with row locks. Never hold a
transaction during extraction or HTTP inference.

Each claim receives a new attempt UUID and a lease renewed periodically. Completion,
heartbeat, and failure updates compare that UUID and running state, fencing stale
attempts. On recovery, expired attempts become delayed retries or exhausted failures.
Treat execution as at-least-once: crashes can repeat computation, but stale attempts
cannot overwrite the published result. Update result and submission `analyzed` in
one transaction; only terminal execution failure marks submission `failed`.

Default automatic budget: three attempts, delayed 30 then 120 seconds for transient
errors. Explicit retry can use remaining budget, not reset it. Invalid input and
unsupported page modes are permanent. Connection errors and 5xx are transient;
401/403 and model-identity mismatch pause worker dispatch and require configuration
repair, rather than exhausting all queued jobs. Bound response sizes and validate
all numeric values and response shape before persistence.

Read current service timeout from private configuration. Set bounded HTTP and lease
durations above that timeout plus transport/heartbeat margins. A timed-out request
does not cancel Python. Before retrying an uncertain attempt after timeout, crash,
or lost database lock, wait at least the service timeout plus margin from the last
possible dispatch and require authenticated readiness. Keep Gunicorn at one worker;
this is the final serialization boundary if an earlier request is still executing.
Do not claim exactly-once inference or immediate cancellation.

## Input equivalence

Pass original single-frame JPEG/PNG/TIFF bytes directly, letting the classifier's
canonical loader apply EXIF transpose and `convert("RGB")`.

For multipage TIFF, a small backend-owned Python helper opens the immutable original,
selects exactly the stored page index, applies Pillow orientation and RGB conversion,
and emits a metadata-free, lossless RGB PNG. No resize, JPEG recompression, white
alpha flattening, custom ICC transformation, or bit-depth normalization is added.
High-bit-depth, palette, color, and transparency behavior follows the canonical
Pillow conversion, including its limitations. Reject unsupported/corrupt pages
explicitly rather than silently changing policy.

Use the installed classifier release's Python/Pillow via configurable interpreter
path, resolving the release path before each extraction. This reuses the already
deployed decoder without loading Torch/models in the helper. Record Pillow version
and helper version. Run helper without a shell, constrain output/time/pixels, use
private temporary storage, and clean output on completion/recovery. Verify exact
TIFF orientation behavior against the classifier's pinned loader before shipping;
do not assume a local research checkout matches the deployed dependency revision.

Pixel-equivalence fixtures must cover distinct multipage content, EXIF orientation,
palette/transparency, and high-bit-depth grayscale. Compare extracted PNG decoded
RGB pixels with canonical per-frame Pillow decoding under the pinned environment.
If that contract cannot be demonstrated, block TIFF inference with a clear error
until fixed; do not classify the first page on behalf of another submission.

## Prediction and provenance contract

Validate and retain classifier `schema_version`, `package_id`, `package_version`,
`class_order`, `probabilities`, `predicted_class`, `calibrated_confidence`,
`normalized_entropy`, and `abstained`. Check finite/ranged probabilities, sum within
floating-point tolerance, argmax/class/confidence consistency, and class identity.
Read `/api/model` around inference and require pre/post metadata to match each other
and prediction identity. Persist temperature, abstention threshold, architecture
order, and device with result. Validate abstention using the returned policy.
Mismatch is not a publishable result; suspend dispatch until service identity is
stable. Do not infer package identity from frontend sample records.

## Frontend scope

Add Analyze to each uploaded submission card, disable while pending, show queued /
running / failed state, and render actual saved prediction with original preview,
class probabilities, confidence, entropy, referral/abstention, and model identity.
Use current cookie/CSRF API wrapper. Repeated clicks and uncertain network responses
recover via GET; never re-upload image to analyze it.

Poll only the currently selected analysis, every 15 seconds initially; back off on
429/network errors, pause when hidden, and stop on terminal state/session expiry or
unmount. Display that other queued images continue server-side. Refresh/navigation
must be able to restore selected submission analysis by ID from server, without
depending on the upload queue's in-memory file bytes. Integrate a live submission
detail route compatible with the frontend's actual deployment/export constraints.
Full history/review redesign is outside this increment.

## Configuration, deployment, and shutdown

Worker reads service token directly from classifier runtime `server.json`, as its
runbook already specifies. Validate ownership, non-symlink regular file, restrictive
permissions, token and timeout types; never log contents. Backend configuration holds
only config-file/interpreter paths and loopback service URL. No new browser secret.

Add worker start script, PM2 definition, and deployment preflight. Deploy database
migration before starting updated code. Stop/drain old worker before replacing its
compiled files; restart exactly one worker and verify heartbeat, singleton lock,
decoder availability, authenticated model readiness and API readiness. Set PM2 kill
grace to allow a current bounded attempt to settle. On SIGINT/SIGTERM stop claiming,
finish bounded active work if possible, then release lock/pool; forced exits recover
through leases. Classifier deployments may cause a transient failure, not lost jobs.
Rollback must preserve additive schema and jobs. Document config repair and recovery.

## Verification and acceptance

- PostgreSQL integration tests: concurrent enqueue/admission, ownership/roles/CSRF,
  restart recovery, lease expiry, stale completion fencing, retry bounds, atomic
  result publication, and singleton worker behavior.
- HTTP fake classifier: real multipart input, corrupt response rejection, service
  outages/auth failure, timeout uncertainty, and policy/identity mismatch.
- Pinned-Pillow pixel-equivalence tests for TIFF handling described above.
- Frontend checks for Analyze per submission, selected-job polling/session cleanup,
  real result rendering, navigation restoration, and no duplicate upload.
- Run existing backend/frontend checks appropriate to changes.
- After authorized deployment, sign in, upload a representative microscopy image,
  click Analyze, observe fast enqueue then persisted real result, refresh to recover
  it, and inspect safe worker evidence. Repeat with distinct TIFF pages. This proves
  integration, not scientific accuracy or shared-host capacity.

Builder may settle naming, table layout/indexes, concrete timeout margins and helper
limits within these constraints. Record chosen operational values in the runbook.
Implementation follows the approved design and a separately reviewed plan.
