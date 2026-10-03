import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { HttpError, type AuthOptions } from "./auth/middleware.js";
import { mountAuth } from "./auth/routes.js";

const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

export function createApp(checkDatabase: () => Promise<unknown>, auth?: AuthOptions) {
  const app = express();

  app.disable("x-powered-by");
  if (auth?.secureCookies) app.set("trust proxy", "loopback");
  if (auth?.trustLocalHttpsProxy) app.use(markLoopbackHttps);
  app.use(helmet());
  app.use(attachRequestId);

  if (auth) {
    app.use(allowOrigins(auth.origins));
    app.use(cors({
      origin: auth.origins, credentials: true,
      methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "X-CSRF-Token"],
    }));
  }
  app.use(express.json({ limit: "16kb" }));

  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", service: "mingocell-api" });
  });

  app.get("/health/ready", async (_req, res) => {
    try {
      await checkDatabase();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({
        status: "unavailable",
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Database connection unavailable.",
        },
      });
    }
  });

  if (auth) mountAuth(app, auth);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  app.use(reportError);

  return app;
}

// DCISM terminates TLS on the same host without forwarding X-Forwarded-Proto, so
// loopback requests are the only ones allowed to claim HTTPS.
function markLoopbackHttps(req: Request, _res: Response, next: NextFunction) {
  if (!LOOPBACK_ADDRESSES.includes(req.socket.remoteAddress ?? "")) {
    return next(new HttpError(403, "PROXY_FORBIDDEN", "Request did not arrive through the local proxy."));
  }
  req.headers["x-forwarded-proto"] = "https";
  next();
}

function attachRequestId(_req: Request, res: Response, next: NextFunction) {
  res.locals.requestId = randomUUID();
  res.setHeader("X-Request-ID", res.locals.requestId);
  next();
}

function allowOrigins(origins: string[]): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get("Origin");
    if (origin && !origins.includes(origin)) {
      return next(new HttpError(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed."));
    }
    next();
  };
}

const reportError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
  } else if (error.type === "entity.too.large") {
    res.status(413).json({ error: { code: "BODY_TOO_LARGE", message: "Request body is too large." } });
  } else if (error.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Provide valid JSON." } });
  } else {
    console.error("Request failed", { requestId: res.locals.requestId });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Request could not be completed." } });
  }
};