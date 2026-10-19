import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { shopDateStart } from "@shared/presence.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-pipeline-"));
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SQUARE_PRESENCE_MIRROR;
delete process.env.PRESENCE_DESK_TOKEN;
delete process.env.SHOP_PIN;
process.env.NODE_ENV = "development";
process.env.PRESENCE_PREVIEW = "1";
process.env.PRESENCE_PUBLIC_URL = "https://shop.example";
process.env.PRESENCE_DEVICE_HASH_PEPPER = "pipeline-pepper";
process.env.PRESENCE_SIGNAL_QUIET_MS = "900000";
process.env.PRESENCE_SIGNAL_RATE_PER_MIN = "1000";

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

const start = shopDateStart("2026-10-14");
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
  const teamId = created.body.id as string;
  assert.equal(typeof teamId, "string");
  assert.equal(created.body.shop.timezone, "America/Chicago");

  const adaAdded = await call("/api/company/people", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ name: "Ada", hourlyCents: 2400 }),
  });
  const benAdded = await call("/api/company/people", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ name: "Ben", hourlyCents: 3600 }),
  });
  const people = benAdded.body.people as Array<{ id: string; name: string; status: string; consentedAt: number | null }>;
  const ada = people.find((person) => person.name === "Ada")!;
  const ben = people.find((person) => person.name === "Ben")!;
  assert.equal(ada.status, "active");
  assert.equal(ada.consentedAt, null);
  assert.notEqual(ada.id, ben.id);

  for (const person of [ada, ben]) {
    const consent = await call("/api/presence/consent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-key": ownerKey },
      body: JSON.stringify({ personId: person.id, consent: true }),
    });
    assert.equal(consent.status, 200);
  }
  const roster = await call("/api/company", { headers: { "x-owner-key": ownerKey } });
  const adaRow = (roster.body.people as Array<{ id: string; consentedAt: number | null }>).find((person) => person.id === ada.id);
  assert.equal(typeof adaRow?.consentedAt, "number");

  async function enroll(personId: string) {
    const setup = await call("/api/presence/phone/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-key": ownerKey },
      body: JSON.stringify({ personId, label: "phone" }),
    });
    assert.equal(setup.status, 200);
    return { token: setup.body.token as string, deviceId: setup.body.deviceId as string };
  }
  const adaPhone = await enroll(ada.id);
  const benPhone = await enroll(ben.id);
  const adaSilent = await call(`/api/presence/health/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  const benSilent = await call(`/api/presence/health/${ben.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(adaSilent.status, 200);
  assert.equal(adaSilent.body.silent, true);
  assert.equal(adaSilent.body.lastSignalAt, null);
  assert.equal(adaSilent.body.status, "off");
  assert.equal(benSilent.body.silent, true);
  const devices = await call("/api/presence/devices", { headers: { "x-owner-key": ownerKey } });
  assert.equal(
    (devices.body.devices as Array<{ personId: string; teamId: string }>).every((device) => device.teamId === teamId),
    true,
  );

  const arrived = await phone(adaPhone.token, "arrive", "geo", at(9));
  assert.equal(arrived.body.applied, "arrive");
  const heard = await call(`/api/presence/health/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(heard.body.silent, false);
  assert.equal(heard.body.lastSource, "phone");
  assert.equal(heard.body.lastTrigger, "geo");
  assert.equal(heard.body.lastSignalAt, at(9));
  assert.equal(heard.body.status, "working");
  setPreviewNow(at(9, 1));
  const wifi = await phone(adaPhone.token, "arrive", "wifi", at(9, 1));
  assert.equal(wifi.body.applied, "seen");
  const again = await phone(adaPhone.token, "arrive", "geo", at(9));
  assert.equal(again.body.duplicate, true);
  const adaState = await call("/api/state", { headers: { "x-person-id": ada.id } });
  const adaIns = (adaState.body.events as Array<{ kind: string }>).filter((event) => event.kind === "clock_in");
  assert.equal(adaIns.length, 1);
  assert.equal(adaState.body.session.clockedIn, true);

  await catchUpPresence();
  const early = await call(`/api/presence/state/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(early.body.teamId, teamId);
  assert.equal(early.body.personId, ada.id);
  assert.equal(early.body.status, "working");
  assert.equal(early.body.moneyCents, 40);
  assert.equal(early.body.engineCents, early.body.moneyCents);
  const benEarly = await call(`/api/presence/state/${ben.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(benEarly.body.moneyCents, 0);
  assert.equal(benEarly.body.status, "off");

  setPreviewNow(at(9, 30));
  const left = await phone(adaPhone.token, "leave", "geo", at(9, 30));
  assert.equal(left.body.applied, "exit");
  await catchUpPresence();
  const pending = await call("/api/presence/me", { headers: { authorization: `Bearer ${adaPhone.token}` } });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.status, "on_break");
  assert.equal(pending.body.accruedMs, 30 * 60_000);
  assert.equal(pending.body.moneyCents, 1200);
  assert.equal(pending.body.engineCents, 1200);

  const dupLeave = await phone(adaPhone.token, "leave", "geo", at(9, 30));
  assert.equal(dupLeave.body.duplicate, true);
  const still = await call(`/api/presence/state/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(still.body.moneyCents, 1200);

  setPreviewNow(at(9, 50));
  await catchUpPresence();
  const onBreak = await call(`/api/presence/state/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(onBreak.body.status, "off");
  assert.equal(onBreak.body.moneyCents, 1200);
  assert.equal(onBreak.body.engineCents, 1200);

  setPreviewNow(at(10));
  const back = await phone(adaPhone.token, "arrive", "wifi", at(10));
  assert.equal(back.body.applied, "arrive");
  setPreviewNow(at(12));
  await catchUpPresence();
  const midday = await call(`/api/presence/state/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(midday.body.accruedMs, 150 * 60_000);
  assert.equal(midday.body.moneyCents, 6000);
  assert.equal(midday.body.engineCents, 6000);

  await reloadPresence();
  const reloaded = await call(`/api/presence/state/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(reloaded.body.accruedMs, midday.body.accruedMs);
  assert.equal(reloaded.body.moneyCents, 6000);
  assert.equal(reloaded.body.engineCents, 6000);

  const dup = await phone(adaPhone.token, "arrive", "geo", at(12));
  assert.equal(dup.body.applied, "seen");
  const afterDup = await call(`/api/presence/state/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(afterDup.body.moneyCents, 6000);

  const benIn = await phone(benPhone.token, "arrive", "geo", at(12));
  assert.equal(benIn.body.personId, ben.id);
  setPreviewNow(at(13));
  const benOut = await phone(benPhone.token, "leave", "geo", at(13));
  assert.equal(benOut.body.applied, "exit");
  setPreviewNow(at(13, 20));
  await catchUpPresence();
  const benHour = await call(`/api/presence/state/${ben.id}`, { headers: { "x-owner-key": ownerKey } });
  const adaSame = await call(`/api/presence/state/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(benHour.body.moneyCents, 3600);
  assert.equal(benHour.body.engineCents, 3600);
  assert.equal(adaSame.body.moneyCents, 9200);
  assert.equal(adaSame.body.engineCents, 9200);

  const log = await call("/api/presence/log", { headers: { "x-owner-key": ownerKey } });
  const punches = log.body.punches as Array<{ personId: string; accepted: boolean }>;
  assert.equal(punches.every((row) => row.personId === ada.id || row.personId === ben.id), true);

  setPreviewNow(at(19, 5));
  await catchUpPresence();
  const closed = await call(`/api/presence/health/${ada.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(closed.body.status, "off");
  assert.equal(closed.body.flag, "auto_closed");
  assert.equal(closed.body.review, "auto_closed");
  assert.equal(closed.body.accruedMs, 570 * 60_000);
  assert.equal(closed.body.moneyCents, 22800);
  assert.equal(closed.body.engineCents, 22800);
  const benClosed = await call(`/api/presence/state/${ben.id}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(benClosed.body.moneyCents, 3600);
  assert.equal(benClosed.body.engineCents, benClosed.body.moneyCents);

  const revoked = await call(`/api/presence/devices/${adaPhone.deviceId}/revoke`, {
    method: "POST",
    headers: { "x-owner-key": ownerKey },
  });
  assert.equal(revoked.status, 200);
  const rejected = await phone(adaPhone.token, "arrive", "geo", at(19, 5));
  assert.equal(rejected.status, 401);

} finally {
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("pipeline ok");
