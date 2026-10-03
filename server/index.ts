import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { flushState } from "./persist";
import { setupVite, serveStatic, log } from "./vite";

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (!path.startsWith("/api") || path === "/api/state") return;
    log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    log(`error ${status} ${err.message || "Internal Server Error"}`);
    if (res.headersSent) return next(err);
    const message = status === 500 ? "Internal Server Error" : err.message || "Internal Server Error";
    res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = Number(process.env.PORT) || 5000;
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });

  const shutdown = () => {
    flushState();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
