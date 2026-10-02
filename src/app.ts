import express from "express";

export const app = express();

app.disable("x-powered-by");

app.get("/health/live", (_req, res) => {
  res.json({ status: "ok", service: "mingocell-api" });
});

app.use((_req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: "Route not found." },
  });
});
