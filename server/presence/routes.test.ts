import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { shopDateStart } from "@shared/presence.ts";
import { SHOP_POINT } from "./geo.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-presence-http-"));
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SQUARE_PRESENCE_MIRROR;
delete process.env.PRESENCE_DESK_TOKEN;
delete process.env.SHOP_PIN;
process.env.NODE_ENV = "development";
process.env.IO_MODE = "public";
process.env.IO_MDNS = "0";
delete process.env.RELAY_PUBLIC_URL;
process.env.PRESENCE_PREVIEW = "1";

const { registerRoutes } = await import("../routes.ts");
const { earnEngine } = await import("../clock/engine.ts");
const { stopPresence, setPreviewNow } = await import("./service.ts");

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
const server = await registerRoutes(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const morning = shopDateStart("2026-10-14") + 9 * 3_600_000;
setPreviewNow(morning);

try {
  const created = await call("/api/company", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "EZ Designs" }),
  });
  assert.equal(created.status, 200);
  const ownerKey = created.body.ownerKey as string;
  const added = await call("/api/company/people", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ name: "Ada", hourlyCents: 2400 }),
  });
  const ada = added.body.people[0].id as string;
  const benAdd = await call("/api/company/people", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ name: "Ben", hourlyCents: 2400 }),
  });
  const ben = benAdd.body.people[1].id as string;

  const wage = await call("/api/presence/square", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({
      people: [{ personId: ada, teamMemberId: "TM_ADA", jobId: "JOB_ADA", wage: { hourly_rate: { amount: 1 } } }],
    }),
  });
  assert.equal(wage.status, 400);

  const square = await call("/api/presence/square", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({
      people: [
        {
          personId: ada,
          teamMemberId: "TM_ADA",
          jobId: "JOB_ADA",
          lunchBreakTypeId: "BR_LUNCH",
          shortBreakTypeId: "BR_SHORT",
        },
      ],
    }),
  });
  assert.equal(square.status, 200);
  assert.equal(square.body.mode, "dry_run");
  assert.equal(JSON.stringify(square.body).includes("SQUARE_ACCESS_TOKEN"), false);

  const hidden = await call("/api/presence/pins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personId: ada, pin: "2468" }),
  });
  assert.equal(hidden.status, 403);

  const pin = await call("/api/presence/pins", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ada, pin: "2468" }),
  });
  assert.equal(pin.status, 200);
  assert.equal(JSON.stringify(pin.body).includes("2468"), false);
  const pinFile = readFileSync(join(process.env.DATA_DIR!, "presence-pins.json"), "utf8");
  assert.equal(pinFile.includes("2468"), false);
  assert.equal(pinFile.includes("scrypt$"), true);

  const headers = {
    "content-type": "application/json",
    "x-person-pin": "2468",
    "x-person-id": ada,
  };
  const beforeConsent = await call("/api/presence/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "arrive",
      ts: morning,
      lat: SHOP_POINT.lat,
      lng: SHOP_POINT.lng,
      accuracy: 20,
      source: "phone",
    }),
  });
  assert.equal(beforeConsent.status, 403);
  assert.equal(beforeConsent.body.reason, "no_consent");
  assert.equal(beforeConsent.body.accepted, false);

  const consent = await call("/api/presence/consent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ada, consent: true }),
  });
  assert.equal(consent.status, 200);
  assert.equal(consent.body.consent, true);

  const outside = await call("/api/presence/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "arrive",
      ts: morning,
      lat: 30.2672,
      lng: -97.7431,
      accuracy: 20,
      source: "phone",
    }),
  });
  assert.equal(outside.status, 200);
  assert.equal(outside.body.accepted, false);
  assert.equal(outside.body.reason, "outside_fence");
  assert.equal(outside.body.you.present, false);
  const stateOut = await call("/api/state", { headers: { "x-person-id": ada } });
  assert.equal(stateOut.body.session.clockedIn, false);
  assert.equal(stateOut.body.presence.streakDays, 0);

  const stolen = await call("/api/presence/punch", {
    method: "POST",
    headers: { ...headers, "x-person-id": ben },
    body: JSON.stringify({
      action: "in",
      source: "iban",
      fix: { lat: SHOP_POINT.lat, lng: SHOP_POINT.lng, accuracyM: 20, capturedAt: morning },
    }),
  });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.body.reason, "wrong_person");
  assert.equal(stolen.body.accepted, false);

  const arrived = await call("/api/presence/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "in",
      source: "iban",
      fix: { lat: SHOP_POINT.lat, lng: SHOP_POINT.lng, accuracyM: 20, capturedAt: morning },
    }),
  });
  assert.equal(arrived.status, 200);
  assert.equal(arrived.body.accepted, true);
  assert.equal(arrived.body.effect, "clock_in");
  assert.equal(arrived.body.type, "arrive");
  assert.equal(arrived.body.you.label, "Clocked in");
  assert.equal(arrived.body.streakDays, 1);
  assert.equal(arrived.body.squareMode, "dry_run");
  assert.equal(JSON.stringify(arrived.body).includes("hourly"), false);
  const stateIn = await call("/api/state", { headers: { "x-person-id": ada } });
  assert.equal(stateIn.body.session.clockedIn, true);
  assert.equal(stateIn.body.presence.dots.find((dot: { personId: string }) => dot.personId === ada).present, true);

  const dry = readFileSync(join(process.env.DATA_DIR!, "presence-square-dry.jsonl"), "utf8");
  assert.equal(dry.includes("TM_ADA"), true);
  assert.equal(dry.includes("hourly_rate"), false);
  assert.equal(dry.includes("amount"), false);
  assert.equal(dry.includes("SQUARE_ACCESS_TOKEN"), false);

  const sloppy = await call("/api/presence/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "leave",
      lat: SHOP_POINT.lat,
      lng: SHOP_POINT.lng,
      accuracy: 400,
      ts: morning,
      source: "phone",
    }),
  });
  assert.equal(sloppy.body.accepted, false);
  assert.equal(sloppy.body.reason, "low_accuracy");
  assert.equal(sloppy.body.you.label, "Clocked in");

  const breakAt = morning + 4 * 3_600_000;
  setPreviewNow(breakAt);
  const lunch = await call("/api/presence/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "leave",
      lat: SHOP_POINT.lat,
      lng: SHOP_POINT.lng,
      accuracy: 20,
      ts: breakAt,
      source: "phone",
    }),
  });
  assert.equal(lunch.body.accepted, true);
  const onBreak = morning + 4 * 3_600_000 + 20 * 60_000;
  setPreviewNow(onBreak);
  const broke = await call("/api/presence");
  const adaBreak = broke.body.dots.find((dot: { personId: string }) => dot.personId === ada);
  assert.equal(adaBreak.phase, "break");
  assert.equal(adaBreak.label, "On break");
  assert.equal(adaBreak.detail, "Lunch");
  assert.equal(adaBreak.present, false);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const paused = await call("/api/state", { headers: { "x-person-id": ada } });
  assert.equal(paused.body.session.clockedIn, false);

  const backAt = onBreak + 30 * 60_000;
  setPreviewNow(backAt);
  const returned = await call("/api/presence/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "arrive",
      lat: SHOP_POINT.lat,
      lng: SHOP_POINT.lng,
      accuracy: 20,
      ts: backAt,
      source: "phone",
    }),
  });
  assert.equal(returned.body.effect, "return");
  assert.equal(returned.body.you.present, true);

  const forgot = await call("/api/presence/corrections", {
    method: "POST",
    headers,
    body: JSON.stringify({ leaveTs: backAt + 60_000 }),
  });
  assert.equal(forgot.status, 400);

  setPreviewNow(backAt + 30 * 60_000);
  const asked = await call("/api/presence/corrections", {
    method: "POST",
    headers,
    body: JSON.stringify({ leaveTs: backAt + 10 * 60_000 }),
  });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.status, "pending");
  const stranger = await call(`/api/presence/corrections/${asked.body.id}/approve`, { method: "POST" });
  assert.equal(stranger.status, 403);
  const still = await call("/api/presence");
  assert.equal(still.body.dots.find((dot: { personId: string }) => dot.personId === ada).phase, "working");

  const approved = await call(`/api/presence/corrections/${asked.body.id}/approve`, {
    method: "POST",
    headers: { "x-owner-key": ownerKey },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "approved");
  const done = await call("/api/presence");
  const closed = done.body.dots.find((dot: { personId: string }) => dot.personId === ada);
  assert.equal(closed.phase, "closed");
  assert.equal(closed.label, "Day closed");
  assert.equal(closed.present, false);
  assert.equal(done.body.streakDays, 1);

  const log = await call("/api/presence/log");
  assert.equal(log.status, 403);
  const ownerLog = await call("/api/presence/log", { headers: { "x-owner-key": ownerKey } });
  assert.equal(ownerLog.status, 200);
  const reasons = ownerLog.body.punches.map((row: { reason: string | null }) => row.reason);
  assert.ok(reasons.includes("outside_fence"));
  assert.ok(reasons.includes("wrong_person"));
  assert.ok(reasons.includes("low_accuracy"));
  assert.equal(JSON.stringify(ownerLog.body).includes("2468"), false);

  const previewOff = await call("/api/presence/preview/now", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ts: morning }),
  });
  assert.equal(previewOff.status, 200);
} finally {
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("presence routes ok");
