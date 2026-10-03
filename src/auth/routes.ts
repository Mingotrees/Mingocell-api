import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { normalizeEmail, verifyPassword } from "./passwords.js";
import {
  destroySession,
  HttpError,
  mountAuthMiddleware,
  requireAuth,
  type AuthOptions,
  type User,
} from "./middleware.js";

const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

export function mountAuth(app: Express, options: AuthOptions) {
  const { cookieName, cookieAttributes } = mountAuthMiddleware(app, options);

  app.get("/api/v1/auth/session", async (req, res) => {
    if (!req.session.csrfToken)
      req.session.csrfToken = randomBytes(32).toString("hex");
    await promisify(req.session.save.bind(req.session))();
    res.json({
      user: res.locals.user ?? null,
      csrfToken: req.session.csrfToken,
      expiresAt: req.session.auth
        ? new Date(req.session.auth.expiresAt).toISOString()
        : null,
      rememberMe: req.session.auth?.rememberMe ?? false,
    });
  });

  const throttleOptions = {
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8" as const,
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMITED",
        message: "Too many login attempts. Try again later.",
      },
    },
  };
  const invalidCredentials = () =>
    new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  // Valid scrypt record used for unknown emails, avoiding a cheap user-existence timing check.
  const dummyHash = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;

  app.post(
    "/api/v1/auth/login",
    rateLimit(throttleOptions),
    rateLimit({
      ...throttleOptions,
      keyGenerator: (req) =>
        createHash("sha256")
          .update(
            typeof req.body?.email === "string"
              ? req.body.email.trim().toLowerCase()
              : "invalid",
          )
          .digest("hex"),
    }),
    async (req, res) => {
      let email: string;
      try {
        email = normalizeEmail(req.body?.email);
      } catch {
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Enter a valid email address.",
        );
      }
      const { password, rememberMe = false } = req.body ?? {};
      if (
        typeof password !== "string" ||
        password.length === 0 ||
        password.length > 128 ||
        typeof rememberMe !== "boolean"
      ) {
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide a password and a boolean rememberMe value.",
        );
      }
      const result = await options.pool.query<User & { password_hash: string }>(
        "SELECT id, email, role, active, auth_version, password_hash FROM mingocell_auth.users WHERE email = $1",
        [email],
      );
      const user = result.rows[0];
      const validPassword = await verifyPassword(
        password,
        user?.password_hash ?? dummyHash,
      );
      if (!user?.active || !validPassword) throw invalidCredentials();

      await promisify(req.session.regenerate.bind(req.session))();
      const duration = rememberMe ? ONE_WEEK : EIGHT_HOURS;
      req.session.auth = {
        userId: user.id,
        version: user.auth_version,
        expiresAt: Date.now() + duration,
        rememberMe,
      };
      req.session.csrfToken = randomBytes(32).toString("hex");
      req.session.cookie.maxAge = duration;
      await promisify(req.session.save.bind(req.session))();
      res.json({
        user: { id: user.id, email: user.email, role: user.role },
        csrfToken: req.session.csrfToken,
        expiresAt: new Date(req.session.auth.expiresAt).toISOString(),
        rememberMe,
      });
    },
  );

  app.post("/api/v1/auth/logout", requireAuth, async (req, res) => {
    await destroySession(req);
    res.clearCookie(cookieName, cookieAttributes);
    res.sendStatus(204);
  });
}
