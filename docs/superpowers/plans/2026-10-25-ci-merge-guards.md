# CI Merge Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for approved native execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require passing frontend/backend CI before main updates, and deploy only the build validated by that CI run.
**Architecture:** Stable `Frontend CI` / `Backend CI` jobs run on pushes and PRs; main-only deployment jobs consume same-run artifacts through `needs`. GitHub branch protection requires checks and up-to-date pull requests after successful feature runs.
**Tech Stack:** GitHub Actions, Node24, PostgreSQL16, Python3.13/Pillow13, Playwright1.64.1/Chromium, actionlint1.7.12, GitHub REST via gh.
**Spec:** `docs/superpowers/specs/2026-10-25-ci-merge-guards-design.md`.

## Global Constraints
- Preserve current feature branches, deployment destination checks and worker drain/migrate/start sequence.
- PR checks use no production credentials or private classifier bundle; no deployment or merge.
- Feature pushes, PRs to main and manual dispatch must run CI; deploy only main after successful CI.
- Read-only workflow token; isolated CI concurrency and serialized non-cancellable deploy concurrency.
- Preserve backend mandatory DB/decoder test execution; no silent integration skips in CI.
- Require current successful CI and PR on main, enforce admins, forbid force pushes/deletion; no added human approval quota.
- Commit and push to existing feature branches per user authorization. Verify actual Actions and resulting protection state.

## Review Focus
1. Valid unit tests but broken exported routes/assets: frontend browser tests run exported production build (Task1).
2. Misrouted API calls hit production: browser fixture blocks non-local/non-fixture network (Task1).
3. CI succeeds while integration suites skip: backend CI explicitly requires DB and decoder env before suite (Task2).
4. Deployment rebuilds different content or reads PR secrets: same-run artifacts, needs/main guards and isolated credentials (Task2).
5. Required check misspelling/skipped CI or unavailable GitHub plan: verify actual check names and protection response, report inability honestly (Task3).

## Task 1: Repeatable frontend browser smoke gate
**Files:** frontend `package.json`, `package-lock.json`, `playwright.config.ts`, `tests/browser/workspace.spec.ts`, `tests/browser/api-fixture.ts`, `scripts/serve-export.mjs`, `.gitignore`.
**Interfaces:** `npm run test:browser` runs Playwright against exported `out/` using `webServer`; API fixture supplies runtime contract without external network; server accepts `PORT` default4173 and binds127.0.0.1.
- [ ] Add browser tests first: anonymous login, authenticated TIFF upload -> per-image Analyze -> queued then saved live result -> reload; failed enqueue remains actionable. Assert exact submission and one POST, no re-upload, preview decoded, no external network.
- [ ] Pin @playwright/test1.64.1 as dev dependency; install and configure Chromium, retries CI1, workers1, trace retain-on-failure, screenshot only-on-failure, report artifacts ignored. Add bounded static server with safe path handling and directory index support; test nonexistent/traversal routes return404.
- [ ] Run tests before implementation to establish missing browser gate/server; implement smallest fixtures/config required. Build with API enabled and same URL as production, intercept fixture origin in browser. Use fixed valid schema and actual multipart assertions.
- [ ] Verify `npm test`, `npm run build`, `npm run test:browser`; inspect browser failures and screenshots. Record evidence.

## Task 2: Split CI from deployment in both repos
**Files:** both `.github/workflows/deploy.yml`; backend `scripts/package-runtime.mjs`, `tests/ci-artifact.test.mjs`; frontend browser files from Task1; backend existing `tests/analysis-deploy.test.mjs` remains behavioral gate.
**Interfaces:** backend artifact `backend-runtime-${sha}` contains only dist/migrations/scripts/deploy/package manifests under root; frontend artifact `frontend-export-${sha}` contains out contents. Stable check names `Backend CI`, `Frontend CI`.
- [ ] Write backend packaging test: package fixture tree, confirm required worker/helper/migrations, reject missing compiled outputs; ensure .env/storage/test files excluded. Run RED; implement explicit manifest packaging to runner staging directory with bounded known paths.
- [ ] CI: npm ci; tests/build and workflow lint. Backend adds mandatory PG/Python fixtures; frontend installs Chromium and browser gate. Upload runtime/export artifacts only on successful CI. Upload browser diagnostics on failure.
- [ ] Deploy: `needs: ci`, main-only push/manual guard, separate production concurrency. Download same-run artifact; no rebuild. Backend retains preflight/drain/migrate/start checks; frontend retains SSH destination assertions and transfer validated export. New build stage must not access SSH secrets.
- [ ] Validate workflow syntax via pinned actionlint and run runtime packaging/deployment behavioral tests. Run backend complete suite with disposable DB+Pillow, Python CLI/decoder checks; frontend complete suite/build/browser. Document CI commands/check names/artifacts in tracked READMEs/runbook.

## Task 3: Review, publish, enable and verify merge gates
**Files:** tracked CI docs and workflow changes; GitHub main protection settings.
**Interfaces:** required check context exactly `Backend CI` / `Frontend CI`, GitHub Actions integration app ID read from actual successful check runs.
- [ ] Fresh independent read-only review of both diffs against dc777e4/b189ca7. Fix Important/Critical findings with regressions; no implementation delegation.
- [ ] Inspect status/diffs/logs, commit intended files, push existing feature branches. Use HTTPS gh credential helper without changing git config if SSH remains unavailable.
- [ ] Inspect actual GitHub Actions runs and logs to success; resolve genuine CI-only failures and re-run affected checks. Do not poll tight loops or deploy.
- [ ] Enable protected main with strict required successful CI (bind actual app), enforce admins, required PR with zero approval quota, no force pushes/deletion. Read protection back and verify exact settings. If API rejects due to plan/permissions, stop enforcement changes and report response; keep valid CI workflows.
- [ ] Report branch SHAs, run URLs, enforcement evidence and classifier-owner follow-up. CI cannot establish production scientific accuracy/capacity.

## Self-review
All design requirements mapped to three tasks. Browser tests share actual public API contract and avoid production network; package manifest consumed unchanged by deployment. Stable checks must be observed before requiring them. User's latest “go” authorizes native implementation after design approval; proceed without another planning-only pause.
