import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { HttpError, type AuthOptions, type PublicUser } from "./auth/middleware.js";
import { mountAuth } from "./auth/routes.js";
import { mountImageRoutes } from "./images/routes.js";
import { mountAnalysisRoutes } from './analysis/routes.js';
import { checkImageStorage, type ImageStorageOptions } from "./images/storage.js";
import { logger as defaultLogger, safeErrorType, type Logger, type LogFields } from "./logging.js";

const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

export function createApp(
  checkDatabase: () => Promise<unknown>,
  auth?: AuthOptions,
  log: Logger = defaultLogger,
  imageStorage?: ImageStorageOptions,
) {
  const app = express();

  app.disable("x-powered-by");
  if (auth?.secureCookies) app.set("trust proxy", "loopback");
  if (auth?.trustLocalHttpsProxy) app.use(markLoopbackHttps);
  app.use(helmet());
  app.use(attachRequestId);
  app.use(logRequests(log));

  if (auth) {
    app.use(allowOrigins(auth.origins));
    app.use(cors({
      origin: auth.origins, credentials: true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key"],
      exposedHeaders: ["Idempotency-Replayed", "X-Request-ID"],
    }));
  }
  app.use(express.json({ limit: "16kb" }));

  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", service: "mingocell-api" });
  });

  app.get("/health/ready", async (_req, res) => {
    try {
      await checkDatabase();
    } catch {
      log("error", "database.readiness.failed", { requestId: res.locals.requestId });
      return res.status(503).json({
        status: "unavailable",
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Database connection unavailable.",
        },
      });
    }

    if (imageStorage) {
      try {
        await checkImageStorage(imageStorage);
      } catch {
        log("error", "storage.readiness.failed", { requestId: res.locals.requestId });
        return res.status(503).json({
          status: "unavailable",
          error: {
            code: "STORAGE_UNAVAILABLE",
            message: "Image storage unavailable.",
          },
        });
      }
    }
    res.json({ status: "ready" });
  });

  if (auth) {
    mountAuth(app, auth);
    if (imageStorage) {
      mountImageRoutes(app, imageStorage);
      mountAnalysisRoutes(app, imageStorage.pool);
    }
  }

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  app.use(reportErrors(log));

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

function logRequests(log: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    let recorded = false;

    const record = (event: "http.request.completed" | "http.request.aborted") => {
      if (recorded) return;
      recorded = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const user = res.locals.user as PublicUser | undefined;
      const fields: Record<string, string | number> = {
        requestId: res.locals.requestId,
        method: req.method,
        route: typeof req.route?.path === "string" ? req.route.path : "unmatched",
        status: res.statusCode,
        durationMs: Math.round(durationMs * 1000) / 1000,
      };
      if (user) {
        fields.actorId = user.id;
        fields.actorRole = user.role;
      }
      log(event === "http.request.completed" ? "info" : "warn", event, fields);
    };

    res.once("finish", () => record("http.request.completed"));
    res.once("close", () => {
      if (!res.writableFinished) record("http.request.aborted");
    });
    next();
  };
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

function reportErrors(log: Logger): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
    } else if (error.type === "entity.too.large") {
      res.status(413).json({ error: { code: "BODY_TOO_LARGE", message: "Request body is too large." } });
    } else if (error.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Provide valid JSON." } });
    } else {
      const fields: LogFields = {
        requestId: res.locals.requestId,
        method: req.method,
        route: typeof req.route?.path === "string" ? req.route.path : "unmatched",
        errorType: safeErrorType(error),
      };
      log("error", "http.request.failed", fields);
      res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Request could not be completed." } });
    }
  };
}
