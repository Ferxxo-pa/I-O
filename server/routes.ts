import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { fightSettingsSchema } from "@shared/fight";
import { levelRulesSchema } from "@shared/ops";
import { configSchema, inputTypeSchema } from "@shared/schema";
import { HttpError, assertShopPin, pinShape } from "./auth/pin";
import { assertPublicReader } from "./auth/reader";
import { webhookNotificationUrl } from "./publicBase";
import { addPerson, companyView, createCompany, joinCompany, setPersonRate, setShopConfig } from "./company";
import { earnEngine } from "./clock/engine";
import { fightBook } from "./fight/book";
import { startPersistence } from "./persist";
import { healthReport } from "./ready";
import { squareConfigured } from "./square/client";
import { timecardFromWebhook } from "./square/labor";
import { signaturesMatch, squareSignature } from "./square/signature";
import { mountPresenceRoutes } from "./presence/routes";
import { applySquareWebhook, squarePayRoster, startSquareSync } from "./square/sync";

function ownerKeyFrom(req: Request): string | null {
  const value = req.header("x-owner-key");
  return value?.trim() ? value.trim() : null;
}

function personIdFrom(req: Request): string | null {
  const body = typeof req.body?.personId === "string" ? req.body.personId.trim() : "";
  const header = req.header("x-person-id")?.trim() ?? "";
  return body || header || null;
}

/** The computer's linked person and the body must name the same person. */
function clockPersonId(req: Request): string {
  const body = typeof req.body?.personId === "string" ? req.body.personId.trim() : "";
  const header = req.header("x-person-id")?.trim() ?? "";
  if (body && header && body !== header) {
    throw new HttpError(403, "This computer is linked to someone else");
  }
  const personId = body || header;
  if (!personId) throw new Error("Choose who you are");
  return personId;
}

async function peopleOnTheBusiness(): Promise<
  Array<{ id: string; name: string; hourlyCents: number | null }>
> {
  if (squareConfigured()) {
    const squarePeople = await squarePayRoster();
    return (squarePeople ?? []).map((person) => ({
      id: person.id,
      name: person.name,
      hourlyCents: person.hourlyCents,
    }));
  }
  return companyView(null).people.map((person) => ({
    id: person.id,
    name: person.name,
    hourlyCents: person.hourlyCents,
  }));
}

function requireOwner(req: Request) {
  const view = companyView(ownerKeyFrom(req));
  if (!view.owner) throw new Error("Only the owner can change that");
  return view;
}

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "local";
}

function requirePin(req: Request) {
  assertShopPin(req.header("x-shop-pin"), clientIp(req), fightBook.pinSet(), (pin) => fightBook.verify(pin));
}

function requirePinIfSet(req: Request) {
  if (fightBook.pinSet()) requirePin(req);
}

function sendError(res: Response, err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : fallback;
  const status =
    err instanceof HttpError ? err.status : message === "Only the owner can change that" ? 403 : 400;
  res.status(status).json({ message });
}

export async function registerRoutes(app: Express): Promise<Server> {
  startPersistence();
  earnEngine.start();
  startSquareSync();

  app.get("/api/health", async (req, res) => {
    if (String(req.query.probe ?? "") === "1") {
      res.json({ ok: true });
      return;
    }
    try {
      res.json(await healthReport());
    } catch {
      res.status(500).json({ ok: false, message: "Health check failed" });
    }
  });

  app.get("/api/state", (req, res) => {
    try {
      assertPublicReader(req);
      res.json(earnEngine.getState(personIdFrom(req)));
    } catch (err) {
      sendError(res, err, "Couldn't load the clock");
    }
  });

  app.post("/api/clock/in", async (req, res) => {
    try {
      requirePin(req);
      const personId = clockPersonId(req);
      const person = (await peopleOnTheBusiness()).find((entry) => entry.id === personId);
      if (!person) throw new Error("That person is not on this business");
      if (!person.hourlyCents) throw new Error("Square has no hourly wage for that person");
      res.json(
        await earnEngine.clockInPerson({
          id: person.id,
          name: person.name,
          hourlyCents: person.hourlyCents,
        }),
      );
    } catch (err) {
      sendError(res, err, "Clock-in failed");
    }
  });

  app.post("/api/clock/out", async (req, res) => {
    try {
      requirePin(req);
      const personId = clockPersonId(req);
      res.json(await earnEngine.clockOutPerson(personId));
    } catch (err) {
      sendError(res, err, "Clock-out failed");
    }
  });

  app.post("/api/input/:type", (req, res) => {
    try {
      assertPublicReader(req);
    } catch (err) {
      return sendError(res, err, "Couldn't record that");
    }
    const parsed = inputTypeSchema.safeParse(req.params.type);
    if (!parsed.success) {
      return res.status(400).json({ message: "Unknown input type" });
    }
    res.json(earnEngine.recordInput(parsed.data));
  });

  // Back-compat alias while UI migrates
  app.post("/api/actions/:type", (req, res) => {
    try {
      assertPublicReader(req);
    } catch (err) {
      return sendError(res, err, "Couldn't record that");
    }
    const parsed = inputTypeSchema.safeParse(req.params.type);
    if (!parsed.success) {
      return res.status(400).json({ message: "Unknown input type" });
    }
    res.json(earnEngine.recordInput(parsed.data));
  });

  app.patch("/api/config", (req, res) => {
    try {
      requirePinIfSet(req);
    } catch (err) {
      return sendError(res, err, "Couldn't save that");
    }
    const parsed = configSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: "Invalid config", issues: parsed.error.issues });
    }
    earnEngine.setConfig(parsed.data);
    res.json(earnEngine.getState());
  });

  app.post("/api/reset", (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ message: "Not found" });
    }
    try {
      requirePinIfSet(req);
    } catch (err) {
      return sendError(res, err, "Couldn't reset");
    }
    res.json(earnEngine.reset());
  });

  app.get("/api/company", (req, res) => {
    res.json(companyView(ownerKeyFrom(req)));
  });

  app.post("/api/company", (req, res) => {
    try {
      requirePinIfSet(req);
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      res.json(createCompany(name, ownerKeyFrom(req)));
    } catch (err) {
      sendError(res, err, "Could not create the company");
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

  app.get("/api/company/who", async (req, res) => {
    try {
      assertPublicReader(req);
      const people = await peopleOnTheBusiness();
      res.json({
        source: squareConfigured() ? "square" : "manual",
        people: people.map((person) => ({ id: person.id, name: person.name })),
      });
    } catch (err) {
      sendError(res, err, "Couldn't load the team");
    }
  });

  app.get("/api/company/roster", async (req, res) => {
    try {
      requirePinIfSet(req);
      requireOwner(req);
      const squarePeople = await squarePayRoster();
      if (squarePeople) return res.json({ source: "square", people: squarePeople });
      res.json({ source: "manual", people: companyView(ownerKeyFrom(req)).people });
    } catch (err) {
      sendError(res, err, "Couldn't load the company");
    }
  });

  app.post("/api/company/people", (req, res) => {
    try {
      requirePinIfSet(req);
      if (squareConfigured()) throw new Error("Square sets the rates");
      requireOwner(req);
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const hourlyCents = Number(req.body?.hourlyCents);
      addPerson(name, hourlyCents);
      earnEngine.setConfig({ hourlyOutputCents: hourlyCents });
      res.json(companyView(ownerKeyFrom(req)));
    } catch (err) {
      sendError(res, err, "Could not add that person");
    }
  });

  app.patch("/api/company/people/:id", (req, res) => {
    try {
      requirePinIfSet(req);
      if (squareConfigured()) throw new Error("Square sets the rates");
      requireOwner(req);
      const hourlyCents = Number(req.body?.hourlyCents);
      setPersonRate(req.params.id, hourlyCents);
      earnEngine.setConfig({ hourlyOutputCents: hourlyCents });
      res.json(companyView(ownerKeyFrom(req)));
    } catch (err) {
      sendError(res, err, "Could not save that rate");
    }
  });

  app.patch("/api/company/shop", (req, res) => {
    try {
      requirePinIfSet(req);
      requireOwner(req);
      const body = req.body ?? {};
      const num = (key: string): number | null | undefined => {
        if (body[key] == null || body[key] === "") return undefined;
        const value = Number(body[key]);
        return Number.isFinite(value) ? value : undefined;
      };
      setShopConfig({
        ...(typeof body.timezone === "string" && body.timezone.trim() ? { timezone: body.timezone.trim() } : {}),
        ...(typeof body.wifiSsid === "string" ? { wifiSsid: body.wifiSsid.trim() } : {}),
        ...(num("fenceLat") !== undefined ? { fenceLat: num("fenceLat")! } : {}),
        ...(num("fenceLng") !== undefined ? { fenceLng: num("fenceLng")! } : {}),
        ...(num("fenceRadiusM") !== undefined ? { fenceRadiusM: num("fenceRadiusM")! } : {}),
        ...(num("openMin") !== undefined ? { openMin: num("openMin")! } : {}),
        ...(num("closeMin") !== undefined ? { closeMin: num("closeMin")! } : {}),
        ...(num("autoCloseMin") !== undefined ? { autoCloseMin: num("autoCloseMin")! } : {}),
        ...(num("graceMs") !== undefined ? { graceMs: num("graceMs")! } : {}),
      });
      res.json(companyView(ownerKeyFrom(req)));
    } catch (err) {
      sendError(res, err, "Couldn't save the shop");
    }
  });

  app.post("/api/fight/pin", (req, res) => {
    try {
      const next = typeof req.body?.pin === "string" ? req.body.pin.trim() : "";
      if (!pinShape(next)) return res.status(400).json({ message: "PIN is 4 to 8 digits" });
      if (fightBook.pinSet()) requirePin(req);
      else requireOwner(req);
      fightBook.setPin(next);
      res.json({ ok: true, pinSet: true });
    } catch (err) {
      sendError(res, err, "Couldn't set the PIN");
    }
  });

  app.patch("/api/fight/settings", (req, res) => {
    try {
      requirePin(req);
      const parsed = fightSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        const custom = parsed.error.issues.find((issue) => issue.code === "custom")?.message;
        return res.status(400).json({ message: custom || "Check those numbers" });
      }
      fightBook.updateSettings(parsed.data);
      res.json(earnEngine.getState(personIdFrom(req)));
    } catch (err) {
      sendError(res, err, "Couldn't save that");
    }
  });

  app.patch("/api/fight/levels", (req, res) => {
    try {
      requirePin(req);
      const parsed = levelRulesSchema.safeParse(req.body);
      if (!parsed.success) {
        const custom = parsed.error.issues.find((issue) => issue.code === "custom")?.message;
        return res.status(400).json({ message: custom || "Check the level table" });
      }
      fightBook.updateLevelRules(parsed.data);
      res.json(earnEngine.getState(personIdFrom(req)));
    } catch (err) {
      sendError(res, err, "Couldn't save levels");
    }
  });

  app.post("/api/square/webhook", (req, res) => {
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    const url = webhookNotificationUrl();
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

    fightBook.markWebhook(Date.now());
    const timecard = timecardFromWebhook(req.body);
    if (timecard) {
      earnEngine.syncRemoteTimecard(timecard);
      return res.status(200).json({ ok: true, timecard: true });
    }

    const result = applySquareWebhook(req.body);
    res.status(200).json({ ok: true, ...result });
  });

  mountPresenceRoutes(app);

  app.use("/api", (_req, res) => {
    res.status(404).json({ message: "Not found" });
  });

  return createServer(app);
}
