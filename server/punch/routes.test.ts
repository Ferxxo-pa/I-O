import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { SHOP_CLOCK } from "@shared/punch";
import { PunchBook } from "./book.ts";
import { mountPunchRoutes, type PunchRouteDeps } from "./routes.ts";
import { resetPinAttempts } from "./pin.ts";
import type { PunchSink } from "./sink.ts";

resetPinAttempts();

const fence = {
  lat: SHOP_CLOCK.lat,
  lng: SHOP_CLOCK.lng,
  radiusM: 120,
  maxAccuracyM: 75,
  maxAgeMs: 30_000,
  maxFutureSkewMs: 15_000,
};
const now = 1_700_000_000_000;
const inside = { lat: fence.lat, lng: fence.lng, accuracyM: 20, capturedAt: now };
const outside = { lat: 30.2672, lng: -97.7431, accuracyM: 20, capturedAt: now };

const sink: PunchSink = {
  mode: "local",
  async clockIn() {
    return { timecardId: "local_http" };
  },
  async clockOut() {},
};
const book = new PunchBook({
  fence,
  sink,
  now: () => now,
  records: [],
  append: () => {},
});

let savedPin = "";
const deps: PunchRouteDeps = {
  book: () => book,
  people: async () => [{ id: "ada", name: "Ada" }],
  pinSet: () => true,
  checkPin: (pin) => pin === "2468",
  setPin: (pin) => {
    savedPin = pin;
  },
  owner: (key) => key === "owner-key",
  shop: () => ({ label: SHOP_CLOCK.label, address: SHOP_CLOCK.address, radiusM: 120, mode: "local" }),
};

const app = express();
app.use(express.json());
mountPunchRoutes(app, deps);

const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
const base = `http://127.0.0.1:${address.port}`;

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json();
  return { status: res.status, body };
}

try {
  const wrong = await call("/api/punch/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "0000" }),
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.message, "Wrong PIN");

  const login = await call("/api/punch/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "2468" }),
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.ok, true);
  assert.equal(JSON.stringify(login.body).includes("2468"), false);

  const stranger = await call("/api/punch/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "1357" }),
  });
  assert.equal(stranger.status, 403);

  const setPin = await call("/api/punch/pin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": "owner-key" },
    body: JSON.stringify({ pin: "1357" }),
  });
  assert.equal(setPin.status, 200);
  assert.equal(savedPin, "1357");
  assert.equal(JSON.stringify(setPin.body).includes("1357"), false);

  const noPin = await call("/api/punch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-person-id": "ada" },
    body: JSON.stringify({ action: "in", fix: inside }),
  });
  assert.equal(noPin.status, 401);

  const headers = {
    "content-type": "application/json",
    "x-shop-pin": "2468",
    "x-person-id": "ada",
  };
  const session = await call("/api/punch/session", { headers });
  assert.equal(session.status, 200);
  assert.equal(session.body.you.name, "Ada");
  assert.equal(session.body.you.clockedIn, false);
  assert.equal(session.body.shop.label, "EZ Designs");
  assert.equal(JSON.stringify(session.body).includes("hourly"), false);
  assert.equal(session.body.shop.lat, undefined);

  const rejected = await call("/api/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "in", fix: outside }),
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.accepted, false);
  assert.equal(rejected.body.reason, "outside_fence");
  assert.equal(rejected.body.message, "Outside the shop");
  assert.equal(rejected.body.you.clockedIn, false);
  assert.ok(rejected.body.distanceM > 120);

  const ben = await call("/api/punch", {
    method: "POST",
    headers: { ...headers, "x-person-id": "ben" },
    body: JSON.stringify({ action: "out", fix: inside }),
  });
  assert.equal(ben.status, 400);

  const orphan = await call("/api/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "out", fix: inside }),
  });
  assert.equal(orphan.body.accepted, false);
  assert.equal(orphan.body.reason, "not_clocked_in");

  const accepted = await call("/api/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "in", fix: inside }),
  });
  assert.equal(accepted.body.accepted, true);
  assert.equal(accepted.body.you.clockedIn, true);
  assert.equal(accepted.body.source, "local");

  const again = await call("/api/punch", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "in", fix: inside }),
  });
  assert.equal(again.body.accepted, false);
  assert.equal(again.body.reason, "already_clocked_in");
  assert.equal(again.body.you.clockedIn, true);

  const hidden = await call("/api/punches");
  assert.equal(hidden.status, 403);

  const log = await call("/api/punches", { headers: { "x-owner-key": "owner-key" } });
  assert.equal(log.status, 200);
  assert.equal(log.body.mode, "local");
  assert.ok(log.body.punches.length >= 3);
  const names = log.body.punches.map((row: { personName: string }) => row.personName);
  assert.ok(names.every((name: string) => name === "Ada"));
  const reasons = log.body.punches.map((row: { reason: string | null }) => row.reason);
  assert.ok(reasons.includes("outside_fence"));
  assert.ok(reasons.includes("already_clocked_in"));
  assert.ok(reasons.includes("not_clocked_in"));
  assert.equal(JSON.stringify(log.body).includes("wage"), false);
  assert.equal(JSON.stringify(log.body).includes("SQUARE_ACCESS_TOKEN"), false);
  const row = log.body.punches[0];
  assert.equal(typeof row.personName, "string");
  assert.equal(typeof row.at, "number");
  assert.equal(typeof row.distanceM, "number");
  assert.equal(typeof row.accepted, "boolean");
} finally {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("punch routes ok");
