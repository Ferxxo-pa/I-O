import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-public-"));
process.env.PUBLIC_BASE_URL = "https://shop.example";
delete process.env.PRESENCE_PUBLIC_URL;
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
delete process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
delete process.env.SHOP_PIN;
process.env.NODE_ENV = "development";

const { publicBaseUrl, webhookNotificationUrl } = await import("./publicBase.ts");
assert.equal(publicBaseUrl(), "https://shop.example");
assert.equal(webhookNotificationUrl(), "https://shop.example/api/square/webhook");
process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = "https://shop.example/api/square/webhook";
assert.equal(webhookNotificationUrl(), "https://shop.example/api/square/webhook");

const { registerRoutes } = await import("./routes.ts");
const { earnEngine } = await import("./clock/engine.ts");
const { stopPresence } = await import("./presence/service.ts");

const app = express();
app.use(express.json());
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

try {
  const created = await call("/api/company", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "EZ Designs" }),
  });
  assert.equal(created.status, 200);
  const ownerKey = created.body.ownerKey as string;
  const owner = { "content-type": "application/json", "x-owner-key": ownerKey };

  const added = await call("/api/company/people", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ name: "Ada", hourlyCents: 2400 }),
  });
  assert.equal(added.status, 200);
  const ada = added.body.people[0].id as string;

  const locked = await call("/api/state");
  assert.equal(locked.status, 403);

  const setPin = await call("/api/fight/pin", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ pin: "2468" }),
  });
  assert.equal(setPin.status, 200);

  const stillLocked = await call("/api/state");
  assert.equal(stillLocked.status, 401);
  const presenceLocked = await call("/api/presence");
  assert.equal(presenceLocked.status, 401);
  const whoLocked = await call("/api/company/who");
  assert.equal(whoLocked.status, 401);
  const inputLocked = await call("/api/input/prompt", { method: "POST" });
  assert.equal(inputLocked.status, 401);

  const pin = { "x-shop-pin": "2468", "content-type": "application/json" };
  const opened = await call("/api/state", { headers: pin });
  assert.equal(opened.status, 200);
  const asOwner = await call("/api/state", { headers: owner });
  assert.equal(asOwner.status, 200);
  const who = await call("/api/company/who", { headers: pin });
  assert.equal(who.status, 200);

  const phone = await call("/api/presence/phone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "arrive", trigger: "geo" }),
  });
  assert.equal(phone.status, 401);

  const setupBlocked = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personId: "nobody" }),
  });
  assert.equal(setupBlocked.status, 403);

  const setup = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ personId: ada, label: "phone" }),
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.url, "https://shop.example/api/presence/phone");
  assert.match(String(setup.body.snippet), /https:\/\/shop\.example\/api\/presence\/phone/);
  assert.match(String(setup.body.snippet), /Bearer /);

  const probe = await call("/api/health?probe=1");
  assert.equal(probe.status, 200);
  assert.equal(probe.body.ok, true);
} finally {
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("public exposure ok");
