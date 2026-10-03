import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { configSchema, inputTypeSchema } from "@shared/schema";
import { addPerson, connectIntegration, createCompany, getCompany } from "./company";
import { earnEngine } from "./clock/engine";
import { signaturesMatch, squareSignature } from "./square/signature";
import { applySquareWebhook, startSquareSync } from "./square/sync";

export async function registerRoutes(app: Express): Promise<Server> {
  earnEngine.start();
  startSquareSync();

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

  app.get("/api/company", (_req, res) => {
    res.json(getCompany());
  });

  app.post("/api/company", (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      res.json(createCompany(name));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create the company";
      res.status(400).json({ message });
    }
  });

  app.post("/api/company/people", (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const telegram = typeof req.body?.telegram === "string" ? req.body.telegram : "";
      res.json(addPerson(name, telegram));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not add that person";
      res.status(400).json({ message });
    }
  });

  app.post("/api/integrations", (req, res) => {
    try {
      const kind = req.body?.kind === "telegram" ? "telegram" : "custom";
      const account = typeof req.body?.account === "string" ? req.body.account : "";
      const label = typeof req.body?.label === "string" ? req.body.label : undefined;
      res.json(connectIntegration(kind, account, label));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not connect that";
      res.status(400).json({ message });
    }
  });

  app.post("/api/square/webhook", (req, res) => {
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    const url = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
    if (!key || !url) {
      return res.status(401).json({ message: "Square webhook is not configured" });
    }

    const raw = (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "";
    const header = req.header("x-square-hmacsha256-signature") ?? "";
    const expected = squareSignature({
      signatureKey: key,
      notificationUrl: url,
      rawBody: raw,
    });
    if (!signaturesMatch(header, expected)) {
      return res.status(403).json({ message: "Invalid Square signature" });
    }

    const result = applySquareWebhook(req.body);
    res.status(200).json({ ok: true, ...result });
  });

  return createServer(app);
}
