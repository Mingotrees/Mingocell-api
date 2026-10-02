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
