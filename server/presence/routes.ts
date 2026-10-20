import type { Express, Request, Response } from "express";
import { z } from "zod";
import { presenceReasonText } from "@shared/presence";
import { HttpError } from "../auth/pin";
import { companyView } from "../company";
import { parsePunchBody } from "./normalize";
import { assertKnownPin, resetPresencePinAttempts } from "./pins";
import {
  askCorrection,
  deskAuthorized,
  personById,
  presenceLog,
  presenceNow,
  presencePins,
  presenceView,
  previewEnabled,
  publish,
  resolveCorrection,
  savePersonPin,
  saveSquarePeople,
  setPreviewNow,
  shopPublic,
  squarePeopleView,
  startPresence,
  subscribe,
  takePunch,
} from "./service";

export { resetPresencePinAttempts };

const squarePersonSchema = z
  .object({
    personId: z.string().min(1).max(80),
    teamMemberId: z.string().min(1).max(80),
    jobId: z.string().min(1).max(80).nullable().default(null),
    lunchBreakTypeId: z.string().min(1).max(80).nullable().default(null),
    shortBreakTypeId: z.string().min(1).max(80).nullable().default(null),
  })
  .strict();

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "local";
}

function owner(req: Request): boolean {
  return companyView(req.header("x-owner-key") ?? null).owner;
}

function personPin(req: Request): string {
  const header = req.header("x-person-pin")?.trim() ?? "";
  if (header) return header;
  return typeof req.body?.pin === "string" ? req.body.pin.trim() : "";
}

function claimedPerson(req: Request): string | null {
  const header = req.header("x-person-id")?.trim() ?? "";
  return header || null;
}

function sendError(res: Response, err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : fallback;
  const status = err instanceof HttpError ? err.status : message === "Punch already in progress" ? 409 : 400;
  res.status(status).json({ message });
}

function resultBody(result: Awaited<ReturnType<typeof takePunch>>) {
  const you = result.view.you;
  return {
    accepted: result.record.accepted,
    reason: result.record.reason,
    message: presenceReasonText(result.record.reason),
    type: result.record.type,
    ts: result.record.ts,
    source: result.record.source,
    effect: result.effect,
    distanceM: result.record.distanceM,
    you,
    streakDays: result.view.streakDays,
    week: result.view.week,
    squareMode: result.view.squareMode,
  };
}

async function handlePunch(req: Request, res: Response, sourceFallback: string, desk: boolean) {
  const personId = assertKnownPin(personPin(req), presencePins(), clientIp(req));
  const person = personById(personId);
  if (!person) throw new HttpError(403, "That person is not on this business");
  const parsed = parsePunchBody(req.body, claimedPerson(req), sourceFallback);
  const result = await takePunch({
    person: { id: person.id, name: person.name },
    claimedPersonId: parsed?.claimedPersonId ?? claimedPerson(req),
    type: parsed?.type ?? "arrive",
    fix: parsed ? { lat: parsed.lat, lng: parsed.lng, accuracy: parsed.accuracy, capturedAt: parsed.capturedAt } : null,
    source: parsed?.source ?? sourceFallback,
    desk,
  });
  const status = result.record.reason === "wrong_person" ? 403 : 200;
  res.status(status).json(resultBody(result));
}

export function mountPresenceRoutes(app: Express) {
  startPresence();

  app.get("/api/presence", (req, res) => {
    res.json(presenceView(claimedPerson(req)));
  });

  app.get("/api/presence/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    subscribe(res);
    publish({ kind: "hello", personId: "", ts: presenceNow() });
  });

  app.post("/api/presence/punch", async (req, res) => {
    try {
      await handlePunch(req, res, "phone", false);
    } catch (err) {
      sendError(res, err, "Punch failed");
    }
  });

  app.post("/api/presence/here", async (req, res) => {
    try {
      const desk = deskAuthorized(req.header("x-desk-token"));
      await handlePunch(req, res, "here", desk);
    } catch (err) {
      sendError(res, err, "Couldn't mark you here");
    }
  });

  app.post("/api/presence/corrections", (req, res) => {
    try {
      const personId = assertKnownPin(personPin(req), presencePins(), clientIp(req));
      const person = personById(personId);
      if (!person) throw new HttpError(403, "That person is not on this business");
      const leaveTs =
        typeof req.body?.leaveTs === "number"
          ? req.body.leaveTs
          : typeof req.body?.at === "string"
            ? Date.parse(req.body.at)
            : Number.NaN;
      const row = askCorrection(person, leaveTs);
      res.json({ id: row.id, status: row.status, leaveTs: row.leaveTs });
    } catch (err) {
      sendError(res, err, "Couldn't ask for that");
    }
  });

  app.post("/api/presence/corrections/:id/approve", async (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can approve that");
      const row = await resolveCorrection(req.params.id, "approved");
      res.json({ id: row.id, status: row.status, leaveTs: row.leaveTs });
    } catch (err) {
      sendError(res, err, "Couldn't approve that");
    }
  });

  app.post("/api/presence/corrections/:id/deny", async (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can approve that");
      const row = await resolveCorrection(req.params.id, "denied");
      res.json({ id: row.id, status: row.status });
    } catch (err) {
      sendError(res, err, "Couldn't deny that");
    }
  });

  app.get("/api/presence/corrections", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see that");
      res.json({ corrections: presenceLog().corrections });
    } catch (err) {
      sendError(res, err, "Couldn't load corrections");
    }
  });

  app.get("/api/presence/log", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see the punch log");
      const log = presenceLog();
      res.json({
        shop: shopPublic(),
        squareMode: presenceView(null).squareMode,
        punches: log.punches.map((row) => ({
          id: row.id,
          personId: row.personId,
          personName: row.personName,
          type: row.type,
          ts: row.ts,
          lat: row.lat,
          lng: row.lng,
          accuracy: row.accuracy,
          source: row.source,
          accepted: row.accepted,
          reason: row.reason,
          message: presenceReasonText(row.reason),
          distanceM: row.distanceM,
          closesDay: row.closesDay,
        })),
        corrections: log.corrections,
      });
    } catch (err) {
      sendError(res, err, "Couldn't load punches");
    }
  });

  app.post("/api/presence/pins", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can set a PIN");
      const personId = typeof req.body?.personId === "string" ? req.body.personId.trim() : "";
      const pin = typeof req.body?.pin === "string" ? req.body.pin.trim() : "";
      savePersonPin(personId, pin);
      res.json({ ok: true, personId });
    } catch (err) {
      sendError(res, err, "Couldn't set that PIN");
    }
  });

  app.get("/api/presence/square", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see that");
      res.json({ mode: presenceView(null).squareMode, people: squarePeopleView() });
    } catch (err) {
      sendError(res, err, "Couldn't load Square settings");
    }
  });

  app.put("/api/presence/square", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can change that");
      const flat = JSON.stringify(req.body ?? {});
      if (/"hourly_rate"|"hourlyCents"|"hourly"|"amount"|"wage"/i.test(flat)) {
        return res.status(400).json({ message: "Square config never includes a wage" });
      }
      const parsed = z.object({ people: z.array(squarePersonSchema).max(40) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Check the Square ids" });
      saveSquarePeople(parsed.data.people);
      res.json({ ok: true, mode: presenceView(null).squareMode, people: squarePeopleView() });
    } catch (err) {
      sendError(res, err, "Couldn't save Square settings");
    }
  });

  app.post("/api/presence/preview/now", (req, res) => {
    if (!previewEnabled()) return res.status(404).json({ message: "Not found" });
    const ts = typeof req.body?.ts === "number" ? req.body.ts : null;
    if (ts == null) return res.status(400).json({ message: "Missing ts" });
    setPreviewNow(ts);
    res.json(presenceView(claimedPerson(req)));
  });
}
