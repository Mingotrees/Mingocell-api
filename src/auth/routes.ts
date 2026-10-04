import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Express, Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { normalizeEmail, verifyPassword } from "./passwords.js";
import {
  destroySession,
  HttpError,
  mountAuthMiddleware,
  requireAuth,
  type AuthOptions,
  type PublicUser,
  type User,
} from "./middleware.js";

const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 10;
// Valid scrypt record used for unknown emails, avoiding a cheap user-existence timing check.
const DUMMY_HASH = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;

export function mountAuth(app: Express, options: AuthOptions) {
  const { cookieName, cookieAttributes } = mountAuthMiddleware(app, options);

  app.get("/api/v1/auth/session", async (req, res) => {
    if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString("hex");
    await promisify(req.session.save.bind(req.session))();
    res.json(sessionPayload(req, (res.locals.user ?? null) as PublicUser | null));
  });

  app.post(
    "/api/v1/auth/login",
    loginThrottle(),
    loginThrottle(throttleByEmail),
    loginHandler(options),
  );

  app.post("/api/v1/auth/logout", requireAuth, async (req, res) => {
    await destroySession(req);
    res.clearCookie(cookieName, cookieAttributes);
    res.sendStatus(204);
  });
}

function sessionPayload(req: Request, user: PublicUser | null) {
  return {
    user,
    csrfToken: req.session.csrfToken,
    expiresAt: req.session.auth ? new Date(req.session.auth.expiresAt).toISOString() : null,
    rememberMe: req.session.auth?.rememberMe ?? false,
  };
}

// Per-IP then per-email, so one attacker cannot lock a colleague out of their account.
function loginThrottle(keyGenerator?: (req: Request) => string) {
  return rateLimit({
    windowMs: LOGIN_WINDOW,
    limit: LOGIN_ATTEMPTS,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    message: {
      error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." },
    },
  });
}

function throttleByEmail(req: Request) {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "invalid";
  return createHash("sha256").update(email).digest("hex");
}

function loginHandler(options: AuthOptions): RequestHandler {
  return async (req, res) => {
    const email = readEmail(req.body?.email);
    const { password, rememberMe } = readCredentials(req.body ?? {});
    const user = await findUserByEmail(options.pool, email);
    const passwordMatches = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user?.active || !passwordMatches) throw invalidCredentials();

    const duration = rememberMe ? ONE_WEEK : EIGHT_HOURS;
    await promisify(req.session.regenerate.bind(req.session))();
    req.session.auth = {
      userId: user.id,
      version: user.auth_version,
      expiresAt: Date.now() + duration,
      rememberMe,
    };
    req.session.csrfToken = randomBytes(32).toString("hex");
    req.session.cookie.maxAge = duration;
    await promisify(req.session.save.bind(req.session))();

    const publicUser = { id: user.id, email: user.email, role: user.role } satisfies PublicUser;
    res.locals.user = publicUser;
    res.json(sessionPayload(req, publicUser));
  };
}

function readEmail(value: unknown) {
  try {
    return normalizeEmail(value);
  } catch {
    throw new HttpError(400, "INVALID_INPUT", "Enter a valid email address.");
  }
}

function readCredentials(body: Record<string, unknown>) {
  const { password, rememberMe = false } = body;
  const usablePassword = typeof password === "string" && password.length > 0 && password.length <= 128;
  if (!usablePassword || typeof rememberMe !== "boolean") {
    throw new HttpError(400, "INVALID_INPUT", "Provide a password and a boolean rememberMe value.");
  }
  return { password: password as string, rememberMe };
}

async function findUserByEmail(pool: AuthOptions["pool"], email: string) {
  const result = await pool.query<User & { password_hash: string }>(
    "SELECT id, email, role, active, auth_version, password_hash FROM mingocell_auth.users WHERE email = $1",
    [email],
  );
  return result.rows[0];
}

// Unknown email, wrong password and disabled account must stay indistinguishable.
function invalidCredentials() {
  return new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
}
