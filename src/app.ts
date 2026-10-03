import express from "express";

export function createApp(checkDatabase: () => Promise<unknown>) {
  const app = express();

  app.disable("x-powered-by");

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

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  return app;
}
