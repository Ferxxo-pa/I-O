import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { shopDateStart } from "@shared/presence.ts";
import { SHOP_POINT } from "./geo.ts";
import { hmacSha256Hex } from "./sign.ts";
import { resetSignalLimits } from "./replay.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-phone-"));
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SQUARE_PRESENCE_MIRROR;
delete process.env.PRESENCE_DESK_TOKEN;
delete process.env.SHOP_PIN;
process.env.NODE_ENV = "development";
process.env.PRESENCE_PREVIEW = "1";
process.env.PRESENCE_PUBLIC_URL = "https://shop.example";
process.env.PRESENCE_WIFI_HMAC_SECRET = "wifi-test-secret";
process.env.PRESENCE_BLE_HMAC_SECRET = "ble-test-secret";
process.env.PRESENCE_DEVICE_HASH_PEPPER = "test-pepper";
process.env.PRESENCE_SIGNAL_QUIET_MS = "300000";
process.env.PRESENCE_SIGNAL_RATE_PER_MIN = "1000";
process.env.PRESENCE_STATIONARY_MS = String(14 * 60 * 60 * 1000);

const { registerRoutes } = await import("../routes.ts");
const { earnEngine } = await import("../clock/engine.ts");
const { stopPresence, setPreviewNow, catchUpPresence } = await import("./service.ts");

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

async function phaseOf(personId: string) {
  const view = await call("/api/presence");
  return view.body.dots.find((dot: { personId: string }) => dot.personId === personId);
}

async function clocked(personId: string) {
  const state = await call("/api/state", { headers: { "x-person-id": personId } });
  return Boolean(state.body.session.clockedIn);
}

async function punchRows() {
  const log = await call("/api/presence/log", { headers: { "x-owner-key": ownerKey } });
  assert.equal(log.status, 200);
  return log.body.punches as Array<{
    personId: string;
    type: string;
    source: string;
    accepted: boolean;
    ts: number;
    flag: string | null;
    reason: string | null;
  }>;
}

function disk() {
  return readdirSync(process.env.DATA_DIR!).map((name) => readFileSync(join(process.env.DATA_DIR!, name), "utf8")).join("\n");
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
  const names = ["Ada", "Ben", "Chi", "Nia", "Eve", "Gil"];
  const ids: Record<string, string> = {};
  for (const name of names) {
    const added = await call("/api/company/people", {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-key": ownerKey },
      body: JSON.stringify({ name, hourlyCents: 2400 }),
    });
    const people = added.body.people as Array<{ id: string; name: string }>;
    ids[name] = people.find((person) => person.name === name)!.id;
  }

  const hidden = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personId: ids.Ada }),
  });
  assert.equal(hidden.status, 403);

  for (const name of names) {
    const consent = await call("/api/presence/consent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-key": ownerKey },
      body: JSON.stringify({ personId: ids[name], consent: true }),
    });
    assert.equal(consent.status, 200);
  }
  await call("/api/presence/consent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ids.Nia, consent: false }),
  });

  const setup = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ids.Ada, label: "Ada phone" }),
  });
  assert.equal(setup.status, 200);
  const adaToken = setup.body.token as string;
  assert.equal(setup.body.url, "https://shop.example/api/presence/phone");
  assert.equal(setup.body.snippet.includes(`Authorization: Bearer ${adaToken}`), true);
  assert.equal(setup.body.snippet.includes('{"event":"arrive","trigger":"geo"}'), true);
  assert.equal(JSON.stringify(setup.body).includes("hourly"), false);
  const listed = await call("/api/presence/devices", { headers: { "x-owner-key": ownerKey } });
  assert.equal(JSON.stringify(listed.body).includes(adaToken), false);
  assert.equal(disk().includes(adaToken), false);
  assert.equal(disk().includes("sha256$"), true);

  const noToken = await call("/api/presence/phone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "arrive", trigger: "geo" }),
  });
  assert.equal(noToken.status, 401);

  const niaSetup = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ids.Nia }),
  });
  const niaDenied = await phone(niaSetup.body.token as string, "arrive", "geo");
  assert.equal(niaDenied.status, 403);
  assert.equal(niaDenied.body.reason, "no_consent");
  assert.equal((await punchRows()).some((row) => row.personId === ids.Nia), false);
  await call("/api/presence/consent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ids.Nia, consent: true }),
  });

  const extra = await call("/api/presence/phone", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adaToken}` },
    body: JSON.stringify({ event: "arrive", trigger: "geo", personId: ids.Ben }),
  });
  assert.equal(extra.status, 400);

  await call("/api/presence/square", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({
      people: [{ personId: ids.Ada, teamMemberId: "TM_ADA", jobId: "JOB_ADA", lunchBreakTypeId: null, shortBreakTypeId: null }],
    }),
  });

  const arrived = await phone(adaToken, "arrive", "geo");
  assert.equal(arrived.status, 200);
  assert.equal(arrived.body.applied, "arrive");
  assert.equal(arrived.body.personId, ids.Ada);
  assert.equal(await clocked(ids.Ada), true);
  const again = await phone(adaToken, "arrive", "geo");
  assert.equal(again.body.duplicate, true);
  const adaState = await call("/api/state", { headers: { "x-person-id": ids.Ada } });
  const adaIns = (adaState.body.events as Array<{ kind: string }>).filter((event) => event.kind === "clock_in");
  assert.equal(adaIns.length, 1);
  const view = await call("/api/presence");
  assert.equal(view.body.squareMode, "dry_run");
  const dryPath = join(process.env.DATA_DIR!, "presence-square-dry.jsonl");
  if (existsSync(dryPath)) {
    const dry = readFileSync(dryPath, "utf8");
    assert.equal(dry.includes("hourly_rate"), false);
    assert.equal(dry.includes("\"amount\""), false);
  }

  setPreviewNow(at(12));
  const wifiLeave = await phone(adaToken, "leave", "wifi");
  assert.equal(wifiLeave.body.applied, "exit");
  setPreviewNow(at(12, 10));
  await catchUpPresence();
  assert.equal(await clocked(ids.Ada), true);

  const geoLeave = await phone(adaToken, "leave", "geo");
  assert.equal(geoLeave.body.applied, "exit");
  setPreviewNow(at(12, 14));
  await catchUpPresence();
  assert.equal(await clocked(ids.Ada), true);
  setPreviewNow(at(12, 15));
  await catchUpPresence();
  assert.equal(await clocked(ids.Ada), false);
  setPreviewNow(at(12, 20));
  await catchUpPresence();
  assert.equal(await clocked(ids.Ada), false);

  const backOnWifi = await phone(adaToken, "arrive", "wifi");
  assert.equal(backOnWifi.body.applied, "arrive");
  const locationOut = await phone(adaToken, "leave", "geo");
  assert.equal(locationOut.body.applied, "exit");
  setPreviewNow(at(12, 25));
  await catchUpPresence();
  assert.equal(await clocked(ids.Ada), false);

  const chi = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ids.Chi }),
  });
  setPreviewNow(at(7));
  const early = await phone(chi.body.token as string, "arrive", "wifi");
  assert.equal(early.body.applied, "arrive");
  assert.equal(await clocked(ids.Chi), true);
  setPreviewNow(at(19));
  await catchUpPresence();
  assert.equal(await clocked(ids.Chi), false);
  const flagged = await call(`/api/presence/health/${ids.Chi}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(flagged.body.review, "auto_closed");

  await call("/api/presence/pins", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ids.Ben, pin: "1357" }),
  });
  setPreviewNow(at(9));
  const manual = await call("/api/presence/punch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-person-pin": "1357" },
    body: JSON.stringify({
      type: "arrive",
      ts: at(9),
      lat: SHOP_POINT.lat,
      lng: SHOP_POINT.lng,
      accuracy: 12,
      source: "phone",
    }),
  });
  assert.equal(manual.body.accepted, true);
  setPreviewNow(at(19));
  await catchUpPresence();
  assert.equal((await phaseOf(ids.Ben)).phase, "working");

  setPreviewNow(at(22));
  const late = await phone(adaToken, "arrive", "geo");
  assert.equal(late.body.reason, "outside_hours");

  process.env.PRESENCE_STATIONARY_MS = "5000";
  const nia = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ids.Nia }),
  });
  setPreviewNow(at(10));
  assert.equal((await phone(nia.body.token as string, "arrive", "geo")).body.applied, "arrive");
  setPreviewNow(at(10) + 6_000);
  await catchUpPresence();
  const stuck = await call(`/api/presence/health/${ids.Nia}`, { headers: { "x-owner-key": ownerKey } });
  assert.equal(stuck.body.review, "stationary");
  const ignored = await phone(nia.body.token as string, "arrive", "wifi");
  assert.equal(ignored.body.reason, "stationary");
  const devices = await call("/api/presence/devices", { headers: { "x-owner-key": ownerKey } });
  const niaDevice = (devices.body.devices as Array<{ id: string; personId: string; stationaryAt: number | null }>).find(
    (row) => row.personId === ids.Nia && row.stationaryAt != null,
  );
  assert.ok(niaDevice);
  const reviewed = await call(`/api/presence/devices/${niaDevice!.id}/review`, {
    method: "POST",
    headers: { "x-owner-key": ownerKey },
  });
  assert.equal(reviewed.body.stationaryAt, null);

  process.env.PRESENCE_STATIONARY_MS = String(48 * 60 * 60 * 1000);
  const eve = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ personId: ids.Eve }),
  });
  setPreviewNow(at(16));
  assert.equal((await phone(eve.body.token as string, "arrive", "geo")).body.applied, "arrive");
  setPreviewNow(shopDateStart("2026-10-15") + 8 * 3_600_000);
  await catchUpPresence();
  const eveDevices = await call("/api/presence/devices", { headers: { "x-owner-key": ownerKey } });
  assert.ok(
    (eveDevices.body.devices as Array<{ personId: string; stationaryAt: number | null }>).some(
      (row) => row.personId === ids.Eve && row.stationaryAt != null,
    ),
  );

  const gilMac = "aa:bb:cc:dd:ee:10";
  const pcMac = "aa:bb:cc:dd:ee:11";
  const strayMac = "aa:bb:cc:dd:ee:12";
  setPreviewNow(at(11));
  const mapPhone = await call("/api/presence/wifi", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ deviceId: gilMac, personId: ids.Gil, label: "Gil phone", kind: "phone" }),
  });
  assert.equal(mapPhone.status, 200);
  assert.equal(JSON.stringify(mapPhone.body).includes(gilMac), false);
  await call("/api/presence/wifi", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-key": ownerKey },
    body: JSON.stringify({ deviceId: pcMac, personId: ids.Gil, label: "Shop PC", kind: "pc" }),
  });
  const wifiBody = JSON.stringify({
    source: "wifi",
    sourceId: "shop-ap",
    event: "seen",
    ts: at(11),
    id: "wifi-gil-seen-01",
    deviceId: "AA-BB-CC-DD-EE-10",
    hostname: "Gil's iPhone",
  });
  const wifi = await call("/api/presence/signal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-presence-signature": hmacSha256Hex(process.env.PRESENCE_WIFI_HMAC_SECRET!, wifiBody),
    },
    body: wifiBody,
  });
  assert.equal(wifi.body.applied, "arrive");
  const pcBody = JSON.stringify({
    source: "wifi",
    sourceId: "shop-ap",
    event: "seen",
    ts: at(11),
    id: "wifi-pc-seen-01",
    deviceId: pcMac,
    hostname: "Ada",
  });
  const beforePc = (await punchRows()).length;
  const pc = await call("/api/presence/signal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-presence-signature": hmacSha256Hex(process.env.PRESENCE_WIFI_HMAC_SECRET!, pcBody),
    },
    body: pcBody,
  });
  assert.equal(pc.body.reason, "not_phone");
  assert.equal((await punchRows()).length, beforePc);
  const strayBody = JSON.stringify({
    source: "wifi",
    sourceId: "shop-ap",
    event: "seen",
    ts: at(11),
    id: "wifi-stray-01",
    deviceId: strayMac,
  });
  const stray = await call("/api/presence/signal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-presence-signature": hmacSha256Hex(process.env.PRESENCE_WIFI_HMAC_SECRET!, strayBody),
    },
    body: strayBody,
  });
  assert.equal(stray.body.reason, "unenrolled");
  const saved = disk();
  assert.equal(saved.includes(gilMac), false);
  assert.equal(saved.includes(pcMac), false);
  assert.equal(saved.includes(strayMac), false);
  assert.equal(saved.includes("wifi-test-secret"), false);

  const bleBody = JSON.stringify({
    source: "ble",
    sourceId: "beacon",
    event: "seen",
    ts: at(11),
    id: "ble-stub-0001",
    deviceId: "beacon-1",
  });
  const ble = await call("/api/presence/signal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-presence-signature": hmacSha256Hex(process.env.PRESENCE_BLE_HMAC_SECRET!, bleBody),
    },
    body: bleBody,
  });
  assert.equal(ble.body.stub, true);
  assert.equal(ble.body.reason, "ble_stub");

  const revoked = await call(`/api/presence/devices/${setup.body.deviceId}/revoke`, {
    method: "POST",
    headers: { "x-owner-key": ownerKey },
  });
  assert.equal(revoked.status, 200);
  setPreviewNow(at(11));
  const dead = await phone(adaToken, "arrive", "geo");
  assert.equal(dead.status, 401);

  resetSignalLimits();
  process.env.PRESENCE_SIGNAL_RATE_PER_MIN = "2";
  const limitToken = chi.body.token as string;
  const first = await phone(limitToken, "leave", "wifi");
  const second = await phone(limitToken, "leave", "geo");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const third = await phone(limitToken, "arrive", "wifi");
  assert.equal(third.status, 429);
} finally {
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("presence phone ok");
