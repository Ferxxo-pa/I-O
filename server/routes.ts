import type { Express } from "express";
import { createServer, type Server } from "http";
import { configSchema, inputTypeSchema } from "@shared/schema";
import { earnEngine } from "./clock/engine";

export async function registerRoutes(app: Express): Promise<Server> {
  earnEngine.start();

  app.get("/api/state", (_req, res) => {
    res.json(earnEngine.getState());
  });

  app.post("/api/clock/in", async (_req, res) => {
    try {
      res.json(await earnEngine.clockIn());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clock-in failed";
      res.status(400).json({ message });
    }
  });

  app.post("/api/clock/out", async (_req, res) => {
    try {
      res.json(await earnEngine.clockOut());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clock-out failed";
      res.status(400).json({ message });
    }
  });

  app.post("/api/input/:type", (req, res) => {
    const parsed = inputTypeSchema.safeParse(req.params.type);
    if (!parsed.success) {
      return res.status(400).json({ message: "Unknown input type" });
    }
    res.json(earnEngine.recordInput(parsed.data));
  });

  // Back-compat alias while UI migrates
  app.post("/api/actions/:type", (req, res) => {
    const parsed = inputTypeSchema.safeParse(req.params.type);
    if (!parsed.success) {
      return res.status(400).json({ message: "Unknown input type" });
    }
    res.json(earnEngine.recordInput(parsed.data));
  });

  app.patch("/api/config", (req, res) => {
    const parsed = configSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Invalid config", issues: parsed.error.issues });
    }
    earnEngine.setConfig(parsed.data);
    res.json(earnEngine.getState());
  });

  app.post("/api/reset", (_req, res) => {
    res.json(earnEngine.reset());
  });

  return createServer(app);
}
