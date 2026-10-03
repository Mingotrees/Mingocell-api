# MingoCell API

Express 5 + TypeScript. Requires Node.js 24 or newer.

## Local development

```bash
npm install
npm run dev
```

`npm run dev` builds and starts the server. Restart it after source changes.
Optional `.env` settings are documented in `.env.example`; default address is
`127.0.0.1:20282`.

```bash
curl http://127.0.0.1:20282/health/live
npm test
```

Health returns `{"status":"ok","service":"mingocell-api"}`. This is process
liveness only; database and inference are not connected yet.

## PM2

Run from the project directory, on the machine hosting the API:

```bash
npm ci
npm run build
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
pm2 restart mingocell-api --update-env
```

```bash
pm2 stop mingocell-api
pm2 delete mingocell-api
```

Follow DCISM's instructions for reboot persistence. `pm2 save` saves the process
list but does not itself install a boot service.

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

Deployment uploads compiled `dist/` and the package manifests, installs
production dependencies, and restarts PM2. Only obsolete files inside `dist/`
are deleted. Server `.env` is preserved; keep private images and other persistent
data outside `dist/`, preferably outside the deployment directory.

After restart, local and public HTTPS health checks must pass. Inspect each run
in **Actions → Test and deploy to DCISM**. Backend deployments are serialized.

Updates happen in place and may briefly interrupt requests. There is no automatic
rollback: if installation, restart, or verification fails, inspect PM2 logs and
redeploy a known-good revision. A successful health check confirms liveness,
not database readiness or inference availability.
