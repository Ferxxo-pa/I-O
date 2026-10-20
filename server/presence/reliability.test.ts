import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { shopDateStart } from "@shared/presence.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-reliable-"));
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SQUARE_PRESENCE_MIRROR;
delete process.env.PRESENCE_DESK_TOKEN;
delete process.env.SHOP_PIN;
process.env.NODE_ENV = "development";
process.env.IO_MODE = "public";
process.env.IO_MDNS = "0";
delete process.env.RELAY_PUBLIC_URL;
process.env.PRESENCE_PREVIEW = "1";
process.env.PRESENCE_PUBLIC_URL = "https://shop.example";
process.env.PRESENCE_DEVICE_HASH_PEPPER = "reliable-pepper";
process.env.PRESENCE_SIGNAL_QUIET_MS = "900000";
process.env.PRESENCE_SIGNAL_RATE_PER_MIN = "1000";
process.env.PRESENCE_PHONE_MAX_AGE_MS = "600000";
process.env.PRESENCE_SIGNAL_MAX_FUTURE_MS = "15000";

const { registerRoutes } = await import("../routes.ts");
const { earnEngine } = await import("../clock/engine.ts");
const { reloadPresence, setPreviewNow, catchUpPresence, stopPresence } = await import("./service.ts");

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

const start = shopDateStart("2026-10-15");
const at = (hours: number, minutes = 0) => start + (hours * 60 + minutes) * 60_000;

function phone(token: string, event: "arrive" | "leave", trigger: "geo" | "wifi", ts?: number) {
  return call("/api/presence/phone", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(ts == null ? { event, trigger } : { event, trigger, ts }),
  });
}

let ownerKey = "";

try {
  setPreviewNow(at(9));
  const created = await call("/api/company", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "EZ Designs" }),
  });
  ownerKey = created.body.ownerKey as string;
  const headers = { "content-type": "application/json", "x-owner-key": ownerKey };

  async function add(name: string, hourlyCents: number) {
    const added = await call("/api/company/people", { method: "POST", headers, body: JSON.stringify({ name, hourlyCents }) });
    return (added.body.people as Array<{ id: string; name: string }>).find((person) => person.name === name)!;
  }
  const ada = await add("Ada", 2400);
  const ben = await add("Ben", 3600);
  for (const person of [ada, ben]) {
    const consent = await call("/api/presence/consent", {
      method: "POST",
      headers,
      body: JSON.stringify({ personId: person.id, consent: true }),
    });
    assert.equal(consent.status, 200);
  }
  async function enroll(personId: string) {
    const setup = await call("/api/presence/phone/setup", {
      method: "POST",
      headers,
      body: JSON.stringify({ personId, label: "phone" }),
    });
    assert.equal(setup.status, 200);
    const opened = await call(`${new URL(setup.body.inviteUrl as string).pathname}/open`, { method: "POST" });
    assert.equal(opened.status, 200);
    return opened.body.token as string;
  }
  const adaToken = await enroll(ada.id);
  const benToken = await enroll(ben.id);

  const adaIn = await phone(adaToken, "arrive", "geo", at(9));
  assert.equal(adaIn.body.applied, "arrive");
  setPreviewNow(at(9, 5));
  const oldLeave = await phone(adaToken, "leave", "geo", at(8, 58));
  assert.equal(oldLeave.body.reason, "out_of_order");
  await catchUpPresence();
  const stillIn = await call(`/api/presence/state/${ada.id}`, { headers });
  assert.equal(stillIn.body.status, "working");
  assert.equal(stillIn.body.source, "phone-geo");
  assert.equal(stillIn.body.moneyCents, 200);
  assert.equal(stillIn.body.engineCents, 200);

  const earlier = await phone(adaToken, "arrive", "wifi", at(8, 56));
  assert.equal(earlier.body.reason, "out_of_order");
  await catchUpPresence();
  const fromFirst = await call(`/api/presence/state/${ada.id}`, { headers });
  assert.equal(fromFirst.body.accruedMs, 5 * 60_000);
  assert.equal(fromFirst.body.moneyCents, 200);
  assert.equal(fromFirst.body.engineCents, 200);

  const wifi = await phone(adaToken, "arrive", "wifi", at(9, 5));
  assert.equal(wifi.body.applied, "seen");
  const adaState = await call("/api/state", { headers: { "x-person-id": ada.id } });
  const ins = (adaState.body.events as Array<{ kind: string }>).filter((event) => event.kind === "clock_in");
  assert.equal(ins.length, 1);

  setPreviewNow(at(9, 20));
  const stale = await phone(benToken, "arrive", "geo", at(9));
  assert.equal(stale.body.applied, "rejected");
  assert.equal(stale.body.reason, "stale_signal");
  const benStale = await call(`/api/presence/state/${ben.id}`, { headers });
  assert.equal(benStale.body.moneyCents, 0);
  assert.equal(benStale.body.status, "off");

  const late = await phone(benToken, "arrive", "geo", at(9, 12));
  assert.equal(late.body.applied, "arrive");
  await catchUpPresence();
  const benLate = await call(`/api/presence/state/${ben.id}`, { headers });
  assert.equal(benLate.body.accruedMs, 8 * 60_000);
  assert.equal(benLate.body.moneyCents, 480);
  assert.equal(benLate.body.engineCents, 480);

  const future = await phone(benToken, "arrive", "wifi", at(9, 21));
  assert.equal(future.body.reason, "future_signal");
  const benFuture = await call(`/api/presence/state/${ben.id}`, { headers });
  assert.equal(benFuture.body.moneyCents, 480);

  setPreviewNow(at(9, 30));
  await catchUpPresence();
  const beforeBoot = await call(`/api/presence/state/${ada.id}`, { headers });
  assert.equal(beforeBoot.body.accruedMs, 30 * 60_000);
  assert.equal(beforeBoot.body.moneyCents, 1200);
  await reloadPresence();
  const afterBoot = await call(`/api/presence/health/${ada.id}`, { headers });
  assert.equal(afterBoot.body.status, "working");
  assert.equal(afterBoot.body.accruedMs, beforeBoot.body.accruedMs);
  assert.equal(afterBoot.body.moneyCents, 1200);
  assert.equal(afterBoot.body.engineCents, 1200);
  assert.equal(afterBoot.body.lastSource, "phone");
  assert.equal(afterBoot.body.silent, false);
  const benBoot = await call(`/api/presence/state/${ben.id}`, { headers });
  assert.equal(benBoot.body.moneyCents, 18 * 60);
  assert.equal(benBoot.body.engineCents, benBoot.body.moneyCents);

  const rio = await add("Rio", 2400);
  const rioConsent = await call("/api/presence/consent", {
    method: "POST",
    headers,
    body: JSON.stringify({ personId: rio.id, consent: true }),
  });
  assert.equal(rioConsent.status, 200);
  const rioToken = await enroll(rio.id);
  const pin = await call("/api/fight/pin", {
    method: "POST",
    headers,
    body: JSON.stringify({ pin: "2468" }),
  });
  assert.equal(pin.status, 200);
  setPreviewNow(at(10));
  const beforeTap = await call("/api/state", { headers: { "x-person-id": rio.id } });
  const beforeIns = (beforeTap.body.events as Array<{ kind: string }>).filter((event) => event.kind === "clock_in").length;
  const tap = await call("/api/clock/in", {
    method: "POST",
    headers: { "content-type": "application/json", "x-shop-pin": "2468", "x-person-id": rio.id },
  });
  assert.equal(tap.status, 200);
  assert.equal(tap.body.session.clockedIn, true);
  const rioArrive = await phone(rioToken, "arrive", "geo", at(10));
  assert.equal(rioArrive.body.applied, "seen");
  const rioOpen = await call(`/api/presence/state/${rio.id}`, { headers });
  assert.equal(rioOpen.body.source, "manual");
  assert.equal(rioOpen.body.status, "working");
  const rioEvents = await call("/api/state", { headers: { "x-person-id": rio.id } });
  const rioIns = (rioEvents.body.events as Array<{ kind: string }>).filter((event) => event.kind === "clock_in");
  assert.equal(rioIns.length, beforeIns + 1);
  setPreviewNow(at(10, 10));
  const rioLeave = await phone(rioToken, "leave", "geo", at(10, 10));
  assert.equal(rioLeave.body.applied, "exit");
  setPreviewNow(at(10, 20));
  await catchUpPresence();
  const rioHeld = await call(`/api/presence/state/${rio.id}`, { headers });
  assert.equal(rioHeld.body.status, "on_break");
  assert.equal(rioHeld.body.moneyCents, 400);
  const rioBack = await phone(rioToken, "arrive", "wifi", at(10, 20));
  assert.equal(rioBack.body.applied, "arrive");
  const rioResumed = await call(`/api/presence/state/${rio.id}`, { headers });
  assert.equal(rioResumed.body.source, "manual");
  assert.equal(rioResumed.body.status, "working");
  setPreviewNow(at(10, 30));
  await catchUpPresence();
  const rioLater = await call(`/api/presence/state/${rio.id}`, { headers });
  assert.equal(rioLater.body.moneyCents, 800);
  assert.equal(rioLater.body.engineCents, 800);
} finally {
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("presence reliability ok");
