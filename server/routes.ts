import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { configSchema, inputTypeSchema } from "@shared/schema";
import { addPerson, companyView, createCompany, joinCompany, setPersonRate } from "./company";
import { earnEngine } from "./clock/engine";
import { startPersistence } from "./persist";
import { squareConfigured } from "./square/client";
import { signaturesMatch, squareSignature } from "./square/signature";
import { applySquareWebhook, squarePayRoster, startSquareSync } from "./square/sync";

function ownerKeyFrom(req: Request): string | null {
  const value = req.header("x-owner-key");
  return value?.trim() ? value.trim() : null;
}

function requireOwner(req: Request) {
  const view = companyView(ownerKeyFrom(req));
  if (!view.owner) throw new Error("Only the owner can change that");
  return view;
}

export async function registerRoutes(app: Express): Promise<Server> {
  startPersistence();
  earnEngine.start();
  startSquareSync();

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

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
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ message: "Not found" });
    }
    res.json(earnEngine.reset());
  });

  app.get("/api/company", (req, res) => {
    res.json(companyView(ownerKeyFrom(req)));
  });

  app.post("/api/company", (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      res.json(createCompany(name, ownerKeyFrom(req)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create the company";
      res.status(400).json({ message });
    }
  });

  app.post("/api/company/join", (req, res) => {
    try {
      const code = typeof req.body?.code === "string" ? req.body.code : "";
      res.json(joinCompany(code, ownerKeyFrom(req)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not join that company";
      res.status(400).json({ message });
    }
  });

  app.get("/api/company/roster", async (req, res) => {
    try {
      requireOwner(req);
      const squarePeople = await squarePayRoster();
      if (squarePeople) return res.json({ source: "square", people: squarePeople });
      res.json({ source: "manual", people: companyView(ownerKeyFrom(req)).people });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't load the company";
      res.status(message === "Only the owner can change that" ? 403 : 400).json({ message });
    }
  });

  app.post("/api/company/people", (req, res) => {
    try {
      if (squareConfigured()) throw new Error("Square sets the rates");
      requireOwner(req);
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const hourlyCents = Number(req.body?.hourlyCents);
      addPerson(name, hourlyCents);
      earnEngine.setConfig({ hourlyOutputCents: hourlyCents });
      res.json(companyView(ownerKeyFrom(req)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not add that person";
      const status = message === "Only the owner can change that" ? 403 : 400;
      res.status(status).json({ message });
    }
  });

  app.patch("/api/company/people/:id", (req, res) => {
    try {
      if (squareConfigured()) throw new Error("Square sets the rates");
      requireOwner(req);
      const hourlyCents = Number(req.body?.hourlyCents);
      setPersonRate(req.params.id, hourlyCents);
      earnEngine.setConfig({ hourlyOutputCents: hourlyCents });
      res.json(companyView(ownerKeyFrom(req)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save that rate";
      const status = message === "Only the owner can change that" ? 403 : 400;
      res.status(status).json({ message });
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

  app.use("/api", (_req, res) => {
    res.status(404).json({ message: "Not found" });
  });

  return createServer(app);
}
