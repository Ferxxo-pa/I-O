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
    return setup.body.token as string;
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
  assert.equal(stillIn.body.moneyCents, 200);
  assert.equal(stillIn.body.engineCents, 200);

  const earlier = await phone(adaToken, "arrive", "wifi", at(8, 56));
  assert.equal(earlier.body.applied, "arrive");
  const earlierAgain = await phone(adaToken, "arrive", "wifi", at(8, 56));
  assert.equal(earlierAgain.body.duplicate, true);
  await catchUpPresence();
  const fromFirst = await call(`/api/presence/state/${ada.id}`, { headers });
  assert.equal(fromFirst.body.accruedMs, 9 * 60_000);
  assert.equal(fromFirst.body.moneyCents, 360);
  assert.equal(fromFirst.body.engineCents, 360);
  assert.ok(fromFirst.body.moneyCents > 0);

  const wifi = await phone(adaToken, "arrive", "wifi", at(9, 5));
  assert.equal(wifi.body.applied, "seen");
  const log = await call("/api/presence/log", { headers });
  const arrives = (log.body.punches as Array<{ personId: string; type: string; accepted: boolean; ts: number }>).filter(
    (row) => row.personId === ada.id && row.type === "arrive" && row.accepted,
  );
  assert.equal(arrives.length, 2);
  assert.equal(Math.min(...arrives.map((row) => row.ts)), at(8, 56));

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
  assert.equal(beforeBoot.body.accruedMs, 34 * 60_000);
  assert.equal(beforeBoot.body.moneyCents, 1360);
  await reloadPresence();
  const afterBoot = await call(`/api/presence/health/${ada.id}`, { headers });
  assert.equal(afterBoot.body.status, "working");
  assert.equal(afterBoot.body.accruedMs, beforeBoot.body.accruedMs);
  assert.equal(afterBoot.body.moneyCents, 1360);
  assert.equal(afterBoot.body.engineCents, 1360);
  assert.equal(afterBoot.body.lastSource, "phone");
  assert.equal(afterBoot.body.silent, false);
  const benBoot = await call(`/api/presence/state/${ben.id}`, { headers });
  assert.equal(benBoot.body.moneyCents, 18 * 60);
  assert.equal(benBoot.body.engineCents, benBoot.body.moneyCents);
} finally {
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("presence reliability ok");
