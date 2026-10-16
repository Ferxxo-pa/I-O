import type { Express, Request, Response } from "express";
import { geoFixSchema, punchActionSchema, punchReasonText, SHOP_CLOCK } from "@shared/punch";
import { z } from "zod";
import { getCompany, getOwnerKey } from "../company";
import { squareConfigured } from "../square/client";
import { squarePayRoster } from "../square/sync";
import type { PunchBook, PunchPerson } from "./book";
import { HttpError, assertShopPin, pinShape } from "./pin";
import { checkPunchPin, getPunchBook, punchPinSet, punchShopPublic, savePunchPin } from "./service";

export type PunchRouteDeps = {
  book: () => PunchBook;
  people: () => Promise<PunchPerson[]>;
  pinSet: () => boolean;
  checkPin: (pin: string) => boolean;
  setPin: (pin: string) => void;
  owner: (key: string | null) => boolean;
  shop: () => { label: string; address: string; radiusM: number; mode: "local" | "square" };
};

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "local";
}

function ownerKeyFrom(req: Request): string | null {
  const value = req.header("x-owner-key");
  return value?.trim() ? value.trim() : null;
}

function personIdFrom(req: Request): string | null {
  const body = typeof req.body?.personId === "string" ? req.body.personId.trim() : "";
  const header = req.header("x-person-id")?.trim() ?? "";
  return body || header || null;
}

function sendError(res: Response, err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : fallback;
  const status =
    err instanceof HttpError ? err.status : message === "Punch already in progress" ? 409 : 400;
  res.status(status).json({ message });
}

function requirePin(req: Request, deps: PunchRouteDeps) {
  const header = req.header("x-shop-pin") ?? (typeof req.body?.pin === "string" ? req.body.pin : undefined);
  assertShopPin(header, clientIp(req), deps.pinSet(), deps.checkPin);
}

async function livePeople(): Promise<PunchPerson[]> {
  if (squareConfigured()) {
    const squarePeople = await squarePayRoster();
    return (squarePeople ?? []).map((person) => ({ id: person.id, name: person.name }));
  }
  return getCompany().people.map((person) => ({ id: person.id, name: person.name }));
}

export function livePunchDeps(): PunchRouteDeps {
  return {
    book: getPunchBook,
    people: livePeople,
    pinSet: punchPinSet,
    checkPin: checkPunchPin,
    setPin: savePunchPin,
    owner: (key) => Boolean(key && getOwnerKey() && key === getOwnerKey()),
    shop: punchShopPublic,
  };
}

function publicPunch(row: ReturnType<PunchBook["list"]>[number]) {
  return {
    id: row.id,
    personId: row.personId,
    personName: row.personName,
    action: row.action,
    at: row.at,
    distanceM: row.distanceM,
    accuracyM: row.accuracyM,
    accepted: row.accepted,
    reason: row.reason,
    message: punchReasonText(row.reason),
    source: row.source,
  };
}

export function mountPunchRoutes(app: Express, deps: PunchRouteDeps = livePunchDeps()): void {
  app.post("/api/punch/login", (req, res) => {
    try {
      const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
      assertShopPin(pin, clientIp(req), deps.pinSet(), deps.checkPin);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, "Couldn't sign in");
    }
  });

  app.post("/api/punch/pin", (req, res) => {
    try {
      if (!deps.owner(ownerKeyFrom(req))) throw new HttpError(403, "Only the owner can change that");
      const pin = typeof req.body?.pin === "string" ? req.body.pin.trim() : "";
      if (!pinShape(pin)) return res.status(400).json({ message: "PIN is 4 to 8 digits" });
      deps.setPin(pin);
      res.json({ ok: true, pinSet: true });
    } catch (err) {
      sendError(res, err, "Couldn't set the PIN");
    }
  });

  app.get("/api/punch/session", async (req, res) => {
    try {
      requirePin(req, deps);
      const people = await deps.people();
      const personId = personIdFrom(req);
      const person = personId ? people.find((entry) => entry.id === personId) : undefined;
      const shop = deps.shop();
      const status = person ? deps.book().status(person.id) : null;
      res.json({
        shop: { label: shop.label, address: shop.address, radiusM: shop.radiusM },
        mode: shop.mode,
        people: people.map((entry) => ({ id: entry.id, name: entry.name })),
        you: person
          ? { id: person.id, name: person.name, clockedIn: status!.clockedIn, clockedInAt: status!.clockedInAt }
          : null,
      });
    } catch (err) {
      sendError(res, err, "Couldn't open the clock");
    }
  });

  app.post("/api/punch/locate", (req, res) => {
    try {
      requirePin(req, deps);
      const parsed = geoFixSchema.safeParse(req.body?.fix ?? req.body);
      if (!parsed.success) return res.status(400).json({ message: "Location reading is incomplete" });
      const decision = deps.book().locate(parsed.data);
      res.json({
        inside: decision.accepted,
        distanceM: decision.distanceM,
        reason: decision.reason,
        message: punchReasonText(decision.reason),
      });
    } catch (err) {
      sendError(res, err, "Couldn't check that location");
    }
  });

  app.post("/api/punch", async (req, res) => {
    try {
      requirePin(req, deps);
      const parsed = z
        .object({ action: punchActionSchema, fix: geoFixSchema })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Location reading is incomplete" });
      const personId = personIdFrom(req);
      if (!personId) throw new HttpError(400, "Choose who you are");
      const person = (await deps.people()).find((entry) => entry.id === personId);
      if (!person) throw new HttpError(400, "That person is not on this business");
      const row = await deps.book().punch(person, parsed.data.action, parsed.data.fix);
      const status = deps.book().status(person.id);
      res.json({
        ...publicPunch(row),
        you: { id: person.id, name: person.name, clockedIn: status.clockedIn, clockedInAt: status.clockedInAt },
      });
    } catch (err) {
      sendError(res, err, "Punch failed");
    }
  });

  app.get("/api/punches", (req, res) => {
    try {
      if (!deps.owner(ownerKeyFrom(req))) throw new HttpError(403, "Only the owner can see the punch log");
      const shop = deps.shop();
      res.json({
        shop: SHOP_CLOCK.label,
        mode: shop.mode,
        punches: deps.book().list().map(publicPunch),
      });
    } catch (err) {
      sendError(res, err, "Couldn't load punches");
    }
  });
}
