import type { Express, Request, Response } from "express";
import { z } from "zod";
import { presenceReasonText } from "@shared/presence";
import { HttpError } from "../auth/pin";
import { assertPublicReader } from "../auth/reader";
import { ioMode, lanBaseUrl } from "../mode";
import { publicBaseUrl } from "../publicBase";
import { companyView } from "../company";
import { ingestSignal } from "./ingest";
import { createInvite, inviteByCode, openInvite, shopFence, shopWifiSsid } from "./invite";
import { joinMissingHtml, joinPageHtml } from "./joinPage";
import { ingestPhone, pingPhone, presencePublicBase } from "./phone";
import { SquareMemberError } from "../square/labor";
import { squareConfigured } from "../square/client";
import { parsePunchBody } from "./normalize";
import { assertKnownPin, resetPresencePinAttempts } from "./pins";
import { isRadioKind } from "./radios";
import {
  askCorrection,
  catchUpPresence,
  consentView,
  deskAuthorized,
  issuePersonDevice,
  linkRosterMember,
  listPersonDevices,
  listRadios,
  personById,
  personForPresentedDevice,
  personHealth,
  personWork,
  personHasConsent,
  presenceLog,
  presenceNow,
  presencePins,
  presenceView,
  previewEnabled,
  publish,
  resolveCorrection,
  reviewPersonDevice,
  reviewRadio,
  revokePersonDevice,
  revokeRadioId,
  saveConsent,
  savePersonPin,
  saveRadio,
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

function identity(req: Request): { id: string; name: string } {
  const token = req.header("x-device-token")?.trim() ?? "";
  if (token) {
    const found = personForPresentedDevice(token, clientIp(req));
    if (!found) throw new HttpError(401, "Unknown device");
    const person = personById(found.personId);
    if (!person) throw new HttpError(403, "That person is not on this business");
    return person;
  }
  const personId = assertKnownPin(personPin(req), presencePins(), clientIp(req));
  const person = personById(personId);
  if (!person) throw new HttpError(403, "That person is not on this business");
  return person;
}

function requireConsent(res: Response, personId: string): boolean {
  if (personHasConsent(personId)) return true;
  res.status(403).json({
    accepted: false,
    reason: "no_consent",
    message: "Presence needs a yes from that person",
  });
  return false;
}

function rawBody(req: Request): string {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  return raw ? raw.toString("utf8") : "";
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
  const person = identity(req);
  if (!requireConsent(res, person.id)) return;
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
    try {
      assertPublicReader(req);
      res.json(presenceView(claimedPerson(req)));
    } catch (err) {
      sendError(res, err, "Couldn't load presence");
    }
  });

  app.get("/api/presence/stream", (req, res) => {
    try {
      assertPublicReader(req);
    } catch (err) {
      sendError(res, err, "Couldn't load presence");
      return;
    }
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
      const person = identity(req);
      if (!requireConsent(res, person.id)) return;
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
          flag: row.flag,
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

  app.post("/api/presence/consent", (req, res) => {
    try {
      const consent = req.body?.consent === true;
      const withdrawing = req.body?.consent === false;
      if (!consent && !withdrawing) return res.status(400).json({ message: "Check the consent flag" });
      if (owner(req)) {
        const personId = typeof req.body?.personId === "string" ? req.body.personId.trim() : "";
        const row = saveConsent(personId, consent);
        return res.json({ personId, consent: consent && row.revokedAt == null, consentedAt: row.consentedAt, revokedAt: row.revokedAt });
      }
      const person = identity(req);
      const claimed = typeof req.body?.personId === "string" ? req.body.personId.trim() : person.id;
      if (claimed !== person.id) throw new HttpError(403, "You can only answer for yourself");
      const row = saveConsent(person.id, consent);
      res.json({ personId: person.id, consent: consent && row.revokedAt == null, consentedAt: row.consentedAt, revokedAt: row.revokedAt });
    } catch (err) {
      sendError(res, err, "Couldn't save that");
    }
  });

  app.get("/api/presence/consent", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see that");
      res.json({ people: consentView() });
    } catch (err) {
      sendError(res, err, "Couldn't load consent");
    }
  });

  app.post("/api/presence/devices", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can enroll a device");
      const personId = typeof req.body?.personId === "string" ? req.body.personId.trim() : "";
      const label = typeof req.body?.label === "string" ? req.body.label : "";
      const issued = issuePersonDevice(personId, label);
      res.json(issued);
    } catch (err) {
      sendError(res, err, "Couldn't enroll that device");
    }
  });

  app.get("/api/presence/devices", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see devices");
      res.json({ devices: listPersonDevices() });
    } catch (err) {
      sendError(res, err, "Couldn't load devices");
    }
  });

  app.post("/api/presence/devices/:id/revoke", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can revoke a device");
      res.json(revokePersonDevice(req.params.id));
    } catch (err) {
      sendError(res, err, "Couldn't revoke that device");
    }
  });

  app.post("/api/presence/devices/:id/review", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can review a device");
      res.json(reviewPersonDevice(req.params.id));
    } catch (err) {
      sendError(res, err, "Couldn't review that device");
    }
  });

  function radioKind(req: Request): "wifi" | "ble" {
    return req.path.includes("/beacons") ? "ble" : "wifi";
  }

  function saveRadioRoute(req: Request, res: Response) {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can map a device");
      const kind = typeof req.body?.kind === "string" ? req.body.kind.trim() : "";
      if (!isRadioKind(kind)) return res.status(400).json({ message: "Mark the device type" });
      const saved = saveRadio(radioKind(req), {
        deviceId: typeof req.body?.deviceId === "string" ? req.body.deviceId : "",
        personId: typeof req.body?.personId === "string" ? req.body.personId.trim() : "",
        label: typeof req.body?.label === "string" ? req.body.label : "",
        kind,
      });
      res.json(saved);
    } catch (err) {
      sendError(res, err, "Couldn't map that device");
    }
  }

  app.post("/api/presence/wifi", saveRadioRoute);
  app.post("/api/presence/beacons", saveRadioRoute);

  app.get("/api/presence/wifi", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see that");
      res.json({ devices: listRadios("wifi") });
    } catch (err) {
      sendError(res, err, "Couldn't load Wi-Fi devices");
    }
  });

  app.get("/api/presence/beacons", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see that");
      res.json({ devices: listRadios("ble") });
    } catch (err) {
      sendError(res, err, "Couldn't load beacons");
    }
  });

  app.post("/api/presence/wifi/:id/revoke", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can revoke a device");
      res.json(revokeRadioId("wifi", req.params.id));
    } catch (err) {
      sendError(res, err, "Couldn't revoke that device");
    }
  });

  app.post("/api/presence/beacons/:id/revoke", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can revoke a device");
      res.json(revokeRadioId("ble", req.params.id));
    } catch (err) {
      sendError(res, err, "Couldn't revoke that device");
    }
  });

  app.post("/api/presence/wifi/:id/review", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can review a device");
      res.json(reviewRadio("wifi", req.params.id));
    } catch (err) {
      sendError(res, err, "Couldn't review that device");
    }
  });

  app.post("/api/presence/beacons/:id/review", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can review a device");
      res.json(reviewRadio("ble", req.params.id));
    } catch (err) {
      sendError(res, err, "Couldn't review that device");
    }
  });

  app.post("/api/presence/phone/setup", async (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can enroll a device");
      const requestedId = typeof req.body?.personId === "string" ? req.body.personId.trim() : "";
      let person = personById(requestedId);
      let squareTeamMemberId = "";
      let squareLocationId = "";
      if (squareConfigured()) {
        try {
          const linked = await linkRosterMember(requestedId);
          person = personById(linked.id);
          squareTeamMemberId = linked.squareTeamMemberId ?? "";
          squareLocationId = linked.squareLocationId ?? "";
        } catch (err) {
          if (err instanceof SquareMemberError) {
            return res.status(409).json({ message: err.message, reason: err.reason, flag: err.reason });
          }
          throw err;
        }
      }
      if (!person) return res.status(400).json({ message: "That person is not on this business" });
      const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label : "Phone";
      const issued = issuePersonDevice(person.id, label, { squareTeamMemberId, squareLocationId });
      const proto = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "https";
      const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "localhost";
      const base = ioMode() === "local-relay"
        ? lanBaseUrl()
        : presencePublicBase({
            configured: publicBaseUrl(),
            proto,
            host,
          });
      const phoneUrl = `${base}/api/presence/phone`;
      const invite = createInvite({
        personId: person.id,
        name: person.name,
        deviceId: issued.id,
        token: issued.token,
        phoneUrl,
        now: presenceNow(),
      });
      res.setHeader("cache-control", "no-store");
      res.json({
        personId: person.id,
        name: person.name,
        deviceId: issued.id,
        inviteUrl: `${base}/join/${invite.code}`,
        squareTeamMemberId: issued.squareTeamMemberId,
        squareLocationId: issued.squareLocationId,
      });
    } catch (err) {
      sendError(res, err, "Couldn't prepare that phone");
    }
  });

  app.get("/api/presence/me", (req, res) => {
    try {
      const header = req.header("authorization") ?? "";
      const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
      const found = personForPresentedDevice(token, clientIp(req));
      if (!found) return res.status(401).json({ message: "Unknown device" });
      const work = personWork(found.personId);
      if (!work) return res.status(404).json({ message: "That person is not on this business" });
      res.json(work);
    } catch (err) {
      sendError(res, err, "Couldn't read the counter");
    }
  });

  app.get("/api/presence/state/:personId", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see that");
      const work = personWork(req.params.personId);
      if (!work) return res.status(404).json({ message: "That person is not on this business" });
      res.json(work);
    } catch (err) {
      sendError(res, err, "Couldn't read the counter");
    }
  });

  app.get("/api/presence/health/:personId", (req, res) => {
    try {
      if (!owner(req)) throw new HttpError(403, "Only Ezven can see that");
      const health = personHealth(req.params.personId);
      if (!health) return res.status(404).json({ message: "That person is not on this business" });
      res.json(health);
    } catch (err) {
      sendError(res, err, "Couldn't read that phone");
    }
  });

  app.post("/api/presence/phone/ping", (req, res) => {
    try {
      const result = pingPhone({ authorization: req.header("authorization"), ip: clientIp(req) });
      res.setHeader("cache-control", "no-store");
      res.status(result.status).json(result.body);
    } catch (err) {
      sendError(res, err, "Couldn't check that phone");
    }
  });

  app.get("/join/:code", (req, res) => {
    const code = req.params.code;
    const invite = inviteByCode(code);
    if (!invite) return res.status(404).type("html").send(joinMissingHtml());
    const proto = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "https";
    const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "localhost";
    const base = ioMode() === "local-relay"
      ? lanBaseUrl()
      : presencePublicBase({ configured: publicBaseUrl(), proto, host });
    const fence = shopFence();
    res.setHeader("cache-control", "no-store");
    res.type("html").send(joinPageHtml({
      name: invite.name,
      ssid: shopWifiSsid(),
      address: fence.address,
      inviteUrl: `${base}/join/${code}`,
      opened: invite.opened,
      relayNote: ioMode() === "local-relay"
        ? "On Premiere, arrive and leave post to this computer. Shortcuts cannot seal a cellular leave, so a leave off the Wi-Fi waits for a tap or the 7 PM close."
        : "",
    }));
  });

  app.post("/join/:code/open", async (req, res) => {
    const result = await openInvite(req.params.code, presenceNow());
    res.setHeader("cache-control", "no-store");
    if (result === "missing") return res.status(404).json({ message: "This link is not valid" });
    if (result === "used") return res.status(410).json({ message: "This link was already used" });
    res.json(result);
  });

  app.post("/api/presence/phone", async (req, res) => {
    try {
      const result = await ingestPhone({
        rawBody: rawBody(req),
        body: req.body,
        authorization: req.header("authorization"),
        ip: clientIp(req),
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      sendError(res, err, "Couldn't take that signal");
    }
  });

  app.post("/api/presence/signal", async (req, res) => {
    try {
      const result = await ingestSignal({
        rawBody: rawBody(req),
        body: req.body,
        deviceToken: req.header("x-device-token")?.trim() || null,
        signature: req.header("x-presence-signature") || req.header("x-hub-signature-256") || null,
        ip: clientIp(req),
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      sendError(res, err, "Couldn't take that signal");
    }
  });

  app.post("/api/presence/catch-up", async (req, res) => {
    if (!previewEnabled()) return res.status(404).json({ message: "Not found" });
    await catchUpPresence();
    res.json(presenceView(claimedPerson(req)));
  });

  app.post("/api/presence/preview/now", (req, res) => {
    if (!previewEnabled()) return res.status(404).json({ message: "Not found" });
    const ts = typeof req.body?.ts === "number" ? req.body.ts : null;
    if (ts == null) return res.status(400).json({ message: "Missing ts" });
    setPreviewNow(ts);
    res.json(presenceView(claimedPerson(req)));
  });
}
