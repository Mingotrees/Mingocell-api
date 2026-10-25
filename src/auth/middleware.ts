import { timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import type { Pool } from "pg";
import { logger as defaultLogger, type Logger } from "../logging.js";

export type Role = "pathologist" | "admin";
export type User = { id: string; email: string; role: Role; active: boolean; auth_version: number };
export type PublicUser = { id: string; email: string; role: Role };

declare module "express-session" {
  interface SessionData {
    csrfToken: string;
    auth?: { userId: string; version: number; expiresAt: number; rememberMe: boolean };
  }
}

export type AuthOptions = {
  pool: Pool;
  store: session.Store;
  secret: string;
  secureCookies: boolean;
  trustLocalHttpsProxy: boolean;
  origins: string[];
};

const ANONYMOUS_LIFETIME = 60 * 60 * 1000;
const REQUEST_WINDOW = 15 * 60 * 1000;
const REQUESTS_PER_WINDOW = 120;
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];
type CookieAttributes = { path: string; httpOnly: boolean; secure: boolean; sameSite: "lax" };

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function createSessionStore(pool: Pool, log: Logger = defaultLogger) {
  const Store = connectPgSimple(session);
  return new Store({
    pool,
    schemaName: "mingocell_auth",
    tableName: "sessions",
    disableTouch: true,
    pruneSessionInterval: 900,
    errorLog: () => log("error", "session.store.failed"),
  });
}

export function authOptions(pool: Pool, store: session.Store): AuthOptions {
  const secret = process.env.SESSION_SECRET ?? "";
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");

  const secureCookies = process.env.NODE_ENV !== "development";
  const trustLocalHttpsProxy = readBooleanFlag("TRUST_LOCAL_HTTPS_PROXY");
  if (trustLocalHttpsProxy && !secureCookies) {
    throw new Error("TRUST_LOCAL_HTTPS_PROXY is only valid in production.");
  }

  return {
    pool,
    store,
    secret,
    secureCookies,
    trustLocalHttpsProxy,
    origins: readOrigins(process.env.CORS_ORIGINS),
  };
}

export function validateProxyBinding(host: string, options: AuthOptions) {
  if (options.trustLocalHttpsProxy && !LOOPBACK_HOSTS.includes(host)) {
    throw new Error("TRUST_LOCAL_HTTPS_PROXY requires HOST=127.0.0.1 or HOST=::1.");
  }
}

export async function destroySession(req: Request) {
  await promisify(req.session.destroy.bind(req.session))();
}

export const requireAuth: RequestHandler = (_req, res, next) => {
  if (!res.locals.user) return next(new HttpError(401, "UNAUTHENTICATED", "Sign in to continue."));
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (_req, res, next) => {
    if (!res.locals.user) return next(new HttpError(401, "UNAUTHENTICATED", "Sign in to continue."));
    if (!roles.includes(res.locals.user.role)) {
      return next(new HttpError(403, "FORBIDDEN", "Your account cannot perform this action."));
    }
    next();
  };
}

export function mountAuthMiddleware(app: Express, options: AuthOptions) {
  const cookieName = options.secureCookies ? "__Host-mingocell.sid" : "mingocell.sid";
  const cookieAttributes = { path: "/", httpOnly: true, secure: options.secureCookies, sameSite: "lax" as const };
  const sessionMiddleware = session({
    name: cookieName,
    secret: options.secret,
    store: options.store,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: { ...cookieAttributes, maxAge: ANONYMOUS_LIFETIME },
  });

  app.use("/api/v1", noStore);
  // ponytail: single-process throttles reset on restart; use a shared store if running replicas.
  app.use("/api/v1", rateLimit({
    windowMs: REQUEST_WINDOW, limit: REQUESTS_PER_WINDOW, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
  }), sessionMiddleware);
  app.use("/api/v1", rejectStaleSessions(options.pool, cookieName, cookieAttributes, sessionMiddleware));
  app.use("/api/v1", requireCsrfToken(options.origins));

  return { cookieName, cookieAttributes };
}

function readBooleanFlag(name: string) {
  const value = process.env[name] ?? "false";
  if (!["true", "false"].includes(value)) throw new Error(`${name} must be true or false.`);
  return value === "true";
}

function readOrigins(value: string | undefined) {
  const origins = (value ?? "https://mingocells.dcism.org,http://localhost:3000")
    .split(",").map((origin) => origin.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      throw new Error("CORS_ORIGINS must contain exact HTTP(S) origins without trailing slashes.");
    }
  }
  return origins;
}

function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

// Re-reads the account on every authenticated request so deactivation, expiry and
// password resets take effect without waiting for the session to end.
function rejectStaleSessions(
  pool: Pool,
  cookieName: string,
  cookieAttributes: CookieAttributes,
  sessionMiddleware: RequestHandler,
): RequestHandler {
  return async (req, res, next) => {
    const auth = req.session.auth;
    if (!auth) return next();

    const result = await pool.query<User>(
      "SELECT id, email, role, active, auth_version FROM mingocell_auth.users WHERE id = $1", [auth.userId]);
    const user = result.rows[0];

    if (auth.expiresAt <= Date.now() || !user?.active || user.auth_version !== auth.version) {
      await destroySession(req);
      res.clearCookie(cookieName, cookieAttributes);
      // The bootstrap route must still answer so the browser can obtain a CSRF token.
      if (req.method === "GET" && req.path === "/auth/session") return sessionMiddleware(req, res, next);
      return next(new HttpError(401, "UNAUTHENTICATED", "Session expired. Sign in again."));
    }

    // Align any cookie reissue with the fixed absolute deadline, never slide expiry.
    req.session.cookie.maxAge = auth.expiresAt - Date.now();
    res.locals.user = { id: user.id, email: user.email, role: user.role } satisfies PublicUser;
    next();
  };
}

function requireCsrfToken(origins: string[]): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.includes(req.method)) return next();

    const origin = req.get("Origin");
    const token = req.get("X-CSRF-Token");
    const expected = req.session.csrfToken;
    const wellFormed = typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
    const matches = Boolean(wellFormed && expected) && timingSafeEqual(Buffer.from(token!), Buffer.from(expected!));

    if (!origin || !origins.includes(origin) || !matches) {
      return next(new HttpError(403, "CSRF_INVALID", "Refresh your session and try again."));
    }
    next();
  };
}
