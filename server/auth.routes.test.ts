import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { squareSignature } from "./square/signature.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-auth-"));
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SHOP_PIN;
delete process.env.HOUR_DURATION_MS;
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = "route-test-key";
process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = "https://shop.example/api/square/webhook";
process.env.NODE_ENV = "development";

const { registerRoutes } = await import("./routes.ts");
const { earnEngine } = await import("./clock/engine.ts");
const { flushState } = await import("./persist.ts");

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

const created = await call("/api/company", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "EZ Designs" }),
});
assert.equal(created.status, 200);
const ownerKey = created.body.ownerKey as string;
assert.ok(ownerKey);

const added = await call("/api/company/people", {
  method: "POST",
  headers: { "content-type": "application/json", "x-owner-key": ownerKey },
  body: JSON.stringify({ name: "Ada", hourlyCents: 2000 }),
});
assert.equal(added.status, 200);
const ada = added.body.people[0].id as string;
const wage = added.body.people[0].hourlyCents;

const blocked = await call("/api/clock/in", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ personId: ada }),
});
assert.equal(blocked.status, 403);

const stranger = await call("/api/fight/pin", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pin: "2468" }),
});
assert.equal(stranger.status, 403);

const setPin = await call("/api/fight/pin", {
  method: "POST",
  headers: { "content-type": "application/json", "x-owner-key": ownerKey },
  body: JSON.stringify({ pin: "2468" }),
});
assert.equal(setPin.status, 200);
assert.equal(setPin.body.pin, undefined);
assert.equal(JSON.stringify(setPin.body).includes("2468"), false);

const wrong = await call("/api/clock/in", {
  method: "POST",
  headers: { "content-type": "application/json", "x-shop-pin": "0000" },
  body: JSON.stringify({ personId: ada }),
});
assert.equal(wrong.status, 401);

const clocked = await call("/api/clock/in", {
  method: "POST",
  headers: { "content-type": "application/json", "x-shop-pin": "2468", "x-person-id": ada },
  body: JSON.stringify({ personId: ada }),
});
assert.equal(clocked.status, 200);
assert.equal(clocked.body.you.clockedIn, true);
assert.equal(JSON.stringify(clocked.body).includes("2468"), false);
assert.equal(JSON.stringify(clocked.body).includes("scrypt$"), false);
assert.equal(clocked.body.fight.pinSet, true);

const out = await call("/api/clock/out", {
  method: "POST",
  headers: { "content-type": "application/json", "x-shop-pin": "2468" },
  body: JSON.stringify({ personId: ada }),
});
assert.equal(out.status, 200);
assert.equal(out.body.you.clockedIn, false);

const badSettings = await call("/api/fight/settings", {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-shop-pin": "2468" },
  body: JSON.stringify({
    fixedMonthlyCents: 290_000,
    materialsBps: 8_000,
    feeBps: 3_000,
    openWeekdays: [1, 2, 3, 4, 5],
    potBps: 1_000,
    avgGoalCents: 104_000,
  }),
});
assert.equal(badSettings.status, 400);

const saved = await call("/api/fight/settings", {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-shop-pin": "2468" },
  body: JSON.stringify({
    fixedMonthlyCents: 300_000,
    materialsBps: 1_300,
    feeBps: 300,
    openWeekdays: [1, 2, 3, 4, 5],
    potBps: 1_500,
    avgGoalCents: 104_000,
  }),
});
assert.equal(saved.status, 200);
assert.equal(saved.body.fight.settings.fixedMonthlyCents, 300_000);
assert.equal(saved.body.fight.settings.potBps, 1_500);
assert.equal(saved.body.config.hourlyOutputCents, wage);

const state = await call("/api/state");
assert.equal(JSON.stringify(state.body).includes("2468"), false);
assert.equal(JSON.stringify(state.body).includes("SQUARE_ACCESS_TOKEN"), false);
assert.equal(state.body.square.connected, false);

const before = state.body.session.collectedCents as number;
const wagesBefore = state.body.session.outputCents as number;
const payload = {
  type: "invoice.payment_made",
  data: {
    object: {
      invoice: {
        id: "inv_route",
        status: "PAID",
        payment_requests: [{ total_completed_amount_money: { amount: 12_500, currency: "USD" } }],
      },
    },
  },
};
const raw = JSON.stringify(payload);
const unsigned = await call("/api/square/webhook", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: raw,
});
assert.equal(unsigned.status, 403);

const signed = squareSignature({
  signatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY!,
  notificationUrl: process.env.SQUARE_WEBHOOK_NOTIFICATION_URL!,
  rawBody: raw,
});
const paid = await fetch(`${base}/api/square/webhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-square-hmacsha256-signature": signed,
  },
  body: raw,
});
assert.equal(paid.status, 200);
const after = await call("/api/state");
assert.equal(after.body.session.collectedCents, before + 12_500);
assert.equal(after.body.session.outputCents, wagesBefore);
assert.equal(after.body.fight.todayCollectedCents >= 12_500, true);
assert.equal(after.body.events[0].label, "+$125");

flushState();
const disk = readFileSync(join(process.env.DATA_DIR!, "io-state.json"), "utf8");
assert.equal(disk.includes("2468"), false);
assert.ok(disk.includes("scrypt$"));
assert.equal(disk.includes("SQUARE_ACCESS_TOKEN"), false);

earnEngine.stop();
await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
console.log("auth routes ok");
