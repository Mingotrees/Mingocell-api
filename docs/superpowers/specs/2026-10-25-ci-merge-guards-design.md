# Frontend/backend CI and required merge checks

Date: 2026-10-25. Status: approved; user authorized native implementation.

## Intent and scope

Catch regressions before changes reach production. User approved making passing
CI mandatory for both `Mingotrees/Mingocell-api` and `Mingotrees/Mingocellfront`.
Build on existing `feat/classifier-analysis` branches and use native execution.
No deployment or merge is authorized by this CI change.

## Current evidence

- Backend tests pull requests to main, main pushes, and manual dispatch. Tests and
  deployment share one job. Ordinary feature pushes do not run CI.
- Frontend tests/builds only on main pushes and manual dispatch, in deployment job.
- GitHub reports both main branches unprotected and no repository rulesets.
- Current account has admin access to both repositories.
- Classifier already tests/lints/packages same-repository PRs; deployment depends
  on packaging. GitHub reports classifier main unprotected; current account has
  no admin access there. Classifier owner must configure its required package
  check separately. Do not alter classifier repository in this change.

## Approaches

**Selected direction: separate required CI job and gated deployment job.** Every
feature push and PR gets a stable check; deployment consumes only the artifact
produced by successful CI for the same run. Required main protection enforces
passing checks. This meets the approved goal and preserves current deployment.

**Alternative: add PR/push triggers to combined test/deploy job.** Less YAML change,
but mixes deployment status with merge checks and does not give clean separation
between validated artifacts and production credentials. Not recommended.

## CI behavior

- Run on branch pushes, PRs targeting main, and manual dispatch. No path filters
  that leave required checks pending. Stable job names: `Backend CI`, `Frontend CI`.
- Read-only repository token. PR jobs never receive deployment SSH secrets.
- Per-ref CI cancellation avoids obsolete builds; production deployments remain
  separately serialized and are never cancelled midway by a newer CI run.
- Backend: npm ci, Node 24 build/unit/PostgreSQL 16 integration suite, Python 3.13
  Pillow 13.0.0 decoder fixtures, hidden-password CLI test, and pinned actionlint.
  Required integration/decoder checks must run, not silently skip. No model bundle
  or production database access.
- Frontend: npm ci, Node 24 type checks/unit tests, static production build with
  actual public API settings, export validation including detail page, and Chromium
  smoke tests for login/session restoration, image upload/Analyze/result/refresh.
  Smoke tests use isolated API contract fixtures, not production credentials or
  private model access. Add a pinned Playwright dev dependency and explicit script.
- Store same-run backend runtime artifact and frontend static export artifact.
  Keep explicit artifact paths; exclude .env, private keys, storage, caches and
  unrelated files. Retain failed browser traces/screenshots for diagnosis.
- Deploy jobs require successful CI via `needs` and run only for main pushes or
  manual main dispatch. Download validated same-run artifact; preserve existing
  destination validation, worker drain/migration/start order and post-deploy checks.

## Main merge protection

After new jobs have reported successfully on feature branches, configure each
repository main branch to require its corresponding stable CI check, require branch
to be current with main, and enforce checks for administrators too. Require PRs
without adding a human approval quota. Disallow force pushes/deletion and bypasses
in policy. These settings are explicit additions to current unprotected state.
Verify resulting settings through GitHub API. If account plan or organization
policy prevents private-repository protection, report actual API failure; do not
claim enforcement or weaken intended checks silently.

## Verification and acceptance

1. Run existing backend/frontend tests/builds and new browser suite locally against
   disposable fixtures; validate workflows with actionlint.
2. Execute deployment shell contract fixtures to retain stop-before-replace and
   migrate-before-start guarantees after job separation.
3. Push feature updates and inspect actual Actions runs until stable checks pass.
4. Set/verify required checks on both main branches. Do not merge to test them.
5. Document check names, commands, failure artifacts, dependency-update path and
   classifier-owner follow-up. CI reduces covered regression risk; production
   configuration, representative inference and runtime monitoring remain separate.

Builder may settle artifact/script names, smoke-fixture layout and bounded job
timeouts. Preserve current deployment contract and existing implementation/tests.
