import { timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Express, Request, RequestHandler } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import type { Pool } from "pg";

export type Role = "pathologist" | "admin";
export type User = { id: string; email: string; role: Role; active: boolean; auth_version: number };

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

export function createSessionStore(pool: Pool) {
  const Store = connectPgSimple(session);
  return new Store({
    pool,
    schemaName: "mingocell_auth",
    tableName: "sessions",
    disableTouch: true,
    pruneSessionInterval: 900,
    errorLog: () => console.error("PostgreSQL session storage operation failed."),
  });
}

export function authOptions(pool: Pool, store: session.Store): AuthOptions {
  const secret = process.env.SESSION_SECRET ?? "";
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  const origins = (process.env.CORS_ORIGINS ?? "https://mingocell.dcism.org,http://localhost:3000")
    .split(",").map((origin) => origin.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      throw new Error("CORS_ORIGINS must contain exact HTTP(S) origins without trailing slashes.");
    }
  }
  const proxySetting = process.env.TRUST_LOCAL_HTTPS_PROXY ?? "false";
  if (!["true", "false"].includes(proxySetting)) {
    throw new Error("TRUST_LOCAL_HTTPS_PROXY must be true or false.");
  }
  const secureCookies = process.env.NODE_ENV !== "development";
  const trustLocalHttpsProxy = proxySetting === "true";
  if (trustLocalHttpsProxy && !secureCookies) {
    throw new Error("TRUST_LOCAL_HTTPS_PROXY is only valid in production.");
  }
  return { pool, store, secret, origins, secureCookies, trustLocalHttpsProxy };
}

export function validateProxyBinding(host: string, options: AuthOptions) {
  if (options.trustLocalHttpsProxy && !["127.0.0.1", "::1"].includes(host)) {
    throw new Error("TRUST_LOCAL_HTTPS_PROXY requires HOST=127.0.0.1 or HOST=::1.");
  }
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function destroySession(req: Request) {
  await promisify(req.session.destroy.bind(req.session))();
}

export const requireAuth: RequestHandler = (_req, res, next) => {
  if (!res.locals.user) return next(new HttpError(401, "UNAUTHENTICATED", "Sign in to continue."));
  next();
};

export function requireRole(role: Role): RequestHandler {
  return (req, res, next) => requireAuth(req, res, (error) => {
    if (error) return next(error);
    if (res.locals.user.role !== role) {
      return next(new HttpError(403, "FORBIDDEN", "Your account cannot perform this action."));
    }
    next();
  });
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

  // ponytail: single-process throttles reset on restart; use a shared store if running replicas.
  app.use("/api/v1", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api/v1", rateLimit({
    windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
  }), sessionMiddleware);

  // Check current account state on every authenticated API request. Version changes
  // also invalidate a racing login that saved its session after a password reset.
  app.use("/api/v1", async (req, res, next) => {
    const auth = req.session.auth;
    if (!auth) return next();
    const result = await options.pool.query<User>(
      "SELECT id, email, role, active, auth_version FROM mingocell_auth.users WHERE id = $1", [auth.userId]);
    const user = result.rows[0];
    if (auth.expiresAt <= Date.now() || !user?.active || user.auth_version !== auth.version) {
      await destroySession(req);
      res.clearCookie(cookieName, cookieAttributes);
      if (req.method === "GET" && req.path === "/auth/session") {
        return sessionMiddleware(req, res, next);
      }
      throw new HttpError(401, "UNAUTHENTICATED", "Session expired. Sign in again.");
    }
    // Align any cookie reissue with the fixed absolute deadline, never slide expiry.
    req.session.cookie.maxAge = auth.expiresAt - Date.now();
    res.locals.user = { id: user.id, email: user.email, role: user.role };
    next();
  });

  app.use("/api/v1", (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("Origin");
    const token = req.get("X-CSRF-Token");
    const expected = req.session.csrfToken;
    if (!origin || !options.origins.includes(origin) || !token || !expected ||
        !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return next(new HttpError(403, "CSRF_INVALID", "Refresh your session and try again."));
    }
    next();
  });

  return { cookieName, cookieAttributes };
}
