import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { shopDateStart } from "@shared/presence.ts";
import {
  deviceKey,
  deviceSealMaterial,
  generateSealKey,
  mailboxId,
  openRelayBox,
  sealRelayBox,
  type RelayPayload,
} from "@shared/relayBox.ts";
import { isShopSource, listenHost } from "./lan/bind.ts";
import { handleRelay, resetRelayLimits, type RelayDb, type RelayEnv } from "../relay/src/index.ts";
import { lockSecrets, mustRefuseRoot } from "./secrets.ts";
import { redactLog } from "./vite.ts";

assert.equal(isShopSource("192.168.1.20"), true);
assert.equal(isShopSource("10.0.0.8"), true);
assert.equal(isShopSource("172.16.0.4"), true);
assert.equal(isShopSource("172.31.255.9"), true);
assert.equal(isShopSource("172.15.0.4"), false);
assert.equal(isShopSource("172.32.0.4"), false);
assert.equal(isShopSource("8.8.8.8"), false);
assert.equal(isShopSource("127.0.0.1"), true);
assert.equal(isShopSource("::1"), true);
assert.equal(isShopSource("::ffff:192.168.1.5"), true);
assert.equal(isShopSource("::ffff:1.1.1.1"), false);
assert.equal(isShopSource("fd12:3456::1"), true);
assert.equal(isShopSource(""), false);
assert.equal(listenHost("0.0.0.0", "local-relay", "192.168.1.20"), "192.168.1.20");
assert.equal(listenHost("8.8.8.8", "local-relay", "10.0.0.5"), "10.0.0.5");
assert.equal(listenHost("192.168.1.9", "local-relay", null), "192.168.1.9");
assert.equal(listenHost("", "local-relay", null), "127.0.0.1");
assert.equal(listenHost("127.0.0.1", "local-relay", "192.168.1.1"), "127.0.0.1");
assert.equal(listenHost("0.0.0.0", "public", "192.168.1.1"), "127.0.0.1");
assert.equal(mustRefuseRoot("production", 0), true);
assert.equal(mustRefuseRoot("production", 1000), false);
assert.equal(mustRefuseRoot("development", 0), false);
assert.equal(redactLog("Authorization: Bearer io_phone_secret_value"), "Authorization: Bearer [redacted]");
assert.equal(redactLog("GET /join/abcDEF123"), "GET /join/[redacted]");

const secretDir = mkdtempSync(join(tmpdir(), "io-secrets-"));
const envFile = join(secretDir, ".env");
writeFileSync(envFile, "SQUARE_ACCESS_TOKEN=hidden\n");
writeFileSync(join(secretDir, "io-state.json"), "{}\n");
process.env.IO_ENV_FILE = envFile;
process.env.DATA_DIR = secretDir;
lockSecrets();
assert.equal(statSync(envFile).mode & 0o777, 0o600);
assert.equal(statSync(secretDir).mode & 0o777, 0o700);
assert.equal(statSync(join(secretDir, "io-state.json")).mode & 0o777, 0o600);

const sealKey = generateSealKey();
const sampleToken = "io_security_phone_token";
const sampleKey = await deviceKey(sampleToken);
const sampleMaterial = await deviceSealMaterial(sealKey, sampleKey);
const samplePayload: RelayPayload = { event: "arrive", trigger: "wifi", ts: 1_700_000_000_000, eventId: "security-1" };
const sampleBox = await sealRelayBox(sampleMaterial, sampleKey, samplePayload);
assert.equal(await openRelayBox(sealKey, sampleKey, sampleBox.envelope), null);
const otherMaterial = await deviceSealMaterial(sealKey, "a".repeat(64));
assert.equal(await openRelayBox(otherMaterial, sampleKey, sampleBox.envelope), null);
assert.deepEqual(await openRelayBox(sampleMaterial, sampleKey, sampleBox.envelope), samplePayload);

type BoxRow = { id: string; device_key: string; envelope: string; received_at: number; expires_at: number };
function memoryDb(): RelayDb & { rows: BoxRow[] } {
  const rows: BoxRow[] = [];
  return {
    rows,
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (text.startsWith("INSERT")) {
                const [id, device_key, envelope, received_at, expires_at] = args as [string, string, string, number, number];
                if (!rows.some((row) => row.id === id)) rows.push({ id, device_key, envelope, received_at, expires_at });
              }
              return { success: true };
            },
            async all<T>() {
              return { results: rows as T[] };
            },
          };
        },
      };
    },
  };
}

const workerDb = memoryDb();
const workerEnv: RelayEnv = { DB: workerDb, RELAY_SHOP_SECRET: "shop-secret-test" };
resetRelayLimits();
const plainDrop = await handleRelay(
  new Request("https://relay.example/drop", {
    method: "POST",
    headers: { authorization: `Bearer ${sampleToken}`, "content-type": "application/json" },
    body: JSON.stringify(samplePayload),
  }),
  workerEnv,
  1_000,
);
assert.equal(plainDrop.status, 400);
assert.equal(workerDb.rows.length, 0);
const sealedDrop = await handleRelay(
  new Request("https://relay.example/drop", {
    method: "POST",
    headers: { authorization: `Bearer ${sampleToken}`, "content-type": "application/json" },
    body: JSON.stringify({ box: sampleBox.box, sig: sampleBox.sig }),
  }),
  workerEnv,
  1_000,
);
assert.equal(sealedDrop.status, 200);
assert.equal(workerDb.rows.length, 1);
assert.equal(JSON.stringify(workerDb.rows).includes(sampleToken), false);
assert.equal(JSON.stringify(workerDb.rows).includes(sealKey), false);
assert.equal(JSON.stringify(workerDb.rows).includes('"event"'), false);
assert.equal(workerDb.rows[0].id, await mailboxId(sampleKey, sampleBox.box));

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-security-"));
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SQUARE_PRESENCE_MIRROR;
delete process.env.PRESENCE_DESK_TOKEN;
delete process.env.SHOP_PIN;
delete process.env.PUBLIC_BASE_URL;
delete process.env.PRESENCE_PUBLIC_URL;
process.env.NODE_ENV = "development";
process.env.IO_MODE = "local-relay";
process.env.IO_MDNS = "0";
process.env.PRESENCE_PREVIEW = "1";
process.env.PRESENCE_DEVICE_HASH_PEPPER = "security-pepper";
process.env.PRESENCE_SIGNAL_QUIET_MS = "900000";
process.env.PRESENCE_SIGNAL_RATE_PER_MIN = "1000";
process.env.PRESENCE_PHONE_MAX_AGE_MS = "600000";
process.env.LAN_BASE_URL = "http://io.local:5000";
process.env.RELAY_POLL_MS = "3600000";
process.env.RELAY_SHOP_SECRET = "shop-secret-test";
process.env.RELAY_SEAL_KEY = sealKey;

type MailBox = { id: string; deviceKey: string; envelope: string; receivedAt: number; expiresAt: number };
const boxes: MailBox[] = [];
const shopSecret = process.env.RELAY_SHOP_SECRET;
const mailbox = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers.authorization ?? "") !== `Bearer ${shopSecret}`) {
    res.writeHead(401);
    res.end('{"ok":false}');
    return;
  }
  if (req.method === "GET" && req.url === "/pull") {
    const now = Date.now();
    const live = boxes.filter((box) => box.expiresAt > now);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      messages: live.map((box) => ({
        id: box.id,
        deviceKey: box.deviceKey,
        envelope: box.envelope,
        receivedAt: box.receivedAt,
      })),
    }));
    return;
  }
  if (req.method === "POST" && req.url === "/ack") {
    const ids = new Set((JSON.parse(raw) as { ids?: string[] }).ids ?? []);
    for (let i = boxes.length - 1; i >= 0; i--) if (ids.has(boxes[i].id)) boxes.splice(i, 1);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end("no");
});
await new Promise<void>((resolve) => mailbox.listen(0, "127.0.0.1", resolve));
const mailAddress = mailbox.address();
process.env.RELAY_PUBLIC_URL = `http://127.0.0.1:${typeof mailAddress === "object" && mailAddress ? mailAddress.port : 0}`;

const { registerRoutes } = await import("./routes.ts");
const { earnEngine } = await import("./clock/engine.ts");
const { stopPresence, setPreviewNow, catchUpPresence } = await import("./presence/service.ts");
const { pollRelayOnce, stopRelayPoll } = await import("./relay/poll.ts");

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
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, text };
}

async function queue(token: string, payload: RelayPayload, envelope = "") {
  const key = await deviceKey(token);
  const material = await deviceSealMaterial(sealKey, key);
  const made = envelope ? null : await sealRelayBox(material, key, payload);
  const stored = envelope || made!.envelope;
  const receivedAt = Date.now();
  boxes.push({
    id: await mailboxId(key, made?.box ?? stored),
    deviceKey: key,
    envelope: stored,
    receivedAt,
    expiresAt: receivedAt + 72 * 60 * 60 * 1000,
  });
}

const start = shopDateStart("2026-10-14");
const at = (hours: number, minutes = 0) => start + (hours * 60 + minutes) * 60_000;
const squareToken = "sq0atp-SECURITY-PROBE-TOKEN";

try {
  const lockedState = await call("/api/state");
  assert.equal(lockedState.status, 403);
  const lockedCompany = await call("/api/company");
  assert.equal(lockedCompany.status, 403);
  const lockedHealth = await call("/api/health");
  assert.equal(lockedHealth.status, 403);
  const probe = await call("/api/health?probe=1");
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.body, { ok: true });
  const lockedPresence = await call("/api/presence");
  assert.equal(lockedPresence.status, 403);
  const lockedWho = await call("/api/company/who");
  assert.equal(lockedWho.status, 403);
  const lockedClock = await call("/api/clock/in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personId: "ada" }),
  });
  assert.equal(lockedClock.status, 403);
  const lockedConfig = await call("/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hourDurationMs: 3_600_000 }),
  });
  assert.equal(lockedConfig.status, 403);
  const stream = await fetch(`${base}/api/presence/stream`);
  assert.equal(stream.status, 403);
  const streamText = await stream.text();
  assert.equal(streamText.includes("data:"), false);

  const created = await call("/api/company", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "EZ Designs" }),
  });
  assert.equal(created.status, 200);
  const ownerKey = created.body.ownerKey as string;
  const code = created.body.code as string;
  const owner = { "content-type": "application/json", "x-owner-key": ownerKey };
  const added = await call("/api/company/people", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ name: "Ada", hourlyCents: 2400 }),
  });
  const ada = (added.body.people as Array<{ id: string; name: string }>).find((person) => person.name === "Ada")!.id;
  for (const name of ["Ben", "Chi"]) {
    const row = await call("/api/company/people", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ name, hourlyCents: 2400 }),
    });
    assert.equal(row.status, 200);
  }
  const people = async () => {
    const view = await call("/api/company", { headers: owner });
    return view.body.people as Array<{ id: string; name: string; hourlyCents: number }>;
  };
  const ids = Object.fromEntries((await people()).map((person) => [person.name, person.id]));
  for (const id of Object.values(ids)) {
    const consent = await call("/api/presence/consent", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ personId: id, consent: true }),
    });
    assert.equal(consent.status, 200);
  }

  const joined = await call("/api/company/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(joined.status, 200);
  assert.equal((joined.body.people as Array<{ hourlyCents: number }>)[0].hourlyCents, 0);
  const joinedOwner = await call("/api/company/join", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ code }),
  });
  assert.equal((joinedOwner.body.people as Array<{ name: string; hourlyCents: number }>).find((person) => person.name === "Ada")!.hourlyCents, 2400);

  const setPin = await call("/api/fight/pin", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ pin: "2468" }),
  });
  assert.equal(setPin.status, 200);
  const pin = { "x-shop-pin": "2468", "content-type": "application/json" };
  const stillLocked = await call("/api/state");
  assert.equal(stillLocked.status, 401);
  const opened = await call("/api/state", { headers: pin });
  assert.equal(opened.status, 200);
  process.env.SQUARE_ACCESS_TOKEN = squareToken;
  const stateBody = JSON.stringify((await call("/api/state", { headers: pin })).body);
  const healthBody = JSON.stringify((await call("/api/health", { headers: pin })).body);
  const companyBody = JSON.stringify((await call("/api/company", { headers: pin })).body);
  assert.equal(stateBody.includes(squareToken), false);
  assert.equal(healthBody.includes(squareToken), false);
  assert.equal(companyBody.includes(squareToken), false);
  delete process.env.SQUARE_ACCESS_TOKEN;

  async function enroll(personId: string) {
    setPreviewNow(at(9));
    const setup = await call("/api/presence/phone/setup", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ personId, label: "phone" }),
    });
    assert.equal(setup.status, 200);
    const openedInvite = await call(`${new URL(setup.body.inviteUrl as string).pathname}/open`, { method: "POST" });
    assert.equal(openedInvite.status, 200);
    const page = await fetch(`${base}${new URL(setup.body.inviteUrl as string).pathname}`);
    const html = await page.text();
    assert.equal(html.includes(openedInvite.body.deviceSeal as string), false);
    assert.equal(html.includes(openedInvite.body.token as string), false);
    return {
      token: openedInvite.body.token as string,
      deviceId: setup.body.deviceId as string,
      deviceSeal: openedInvite.body.deviceSeal as string,
    };
  }

  async function postPhone(token: string, event: "arrive" | "leave", ts: number, eventId: string) {
    return call("/api/presence/phone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event, trigger: "wifi", ts, eventId }),
    });
  }

  const adaPhone = await enroll(ada);
  const arriveTs = at(9);
  const leaveTs = at(9, 30);
  setPreviewNow(arriveTs);
  const adaArrive = await postPhone(adaPhone.token, "arrive", arriveTs, "ada-once-arrive");
  assert.equal(adaArrive.body.applied, "arrive");
  setPreviewNow(leaveTs);
  const adaLeave = await postPhone(adaPhone.token, "leave", leaveTs, "ada-once-leave");
  assert.equal(adaLeave.body.applied, "exit");
  setPreviewNow(at(11));
  await catchUpPresence();
  assert.equal(earnEngine.shiftInfo(ada)?.clockedIn, false);
  assert.equal(earnEngine.shiftInfo(ada)?.outputCents, 1200);
  await queue(adaPhone.token, { event: "arrive", trigger: "wifi", ts: at(10), eventId: "ada-once-arrive" });
  const replay = await pollRelayOnce();
  assert.equal(replay.applied, 1);
  assert.equal(earnEngine.shiftInfo(ada)?.clockedIn, false);
  assert.equal(earnEngine.shiftInfo(ada)?.outputCents, 1200);

  const ben = await enroll(ids.Ben);
  setPreviewNow(arriveTs);
  const benArrive = await postPhone(ben.token, "arrive", arriveTs, "ben-arrive-sec");
  assert.equal(benArrive.body.applied, "arrive");
  const benMaterial = await deviceSealMaterial(sealKey, await deviceKey(ben.token));
  const forged = await sealRelayBox(benMaterial, await deviceKey(ben.token), {
    event: "leave",
    trigger: "geo",
    ts: leaveTs,
    eventId: "ben-forged-leave",
  });
  const flipped = `${forged.envelope.slice(0, -2)}${forged.envelope.endsWith("A") ? "B" : "A"}`;
  await queue(ben.token, { event: "leave", trigger: "geo", ts: leaveTs, eventId: "ben-forged-leave" }, flipped);
  setPreviewNow(at(11));
  const rejected = await pollRelayOnce();
  assert.equal(rejected.rejected, 1);
  assert.equal(rejected.applied, 0);
  assert.equal(earnEngine.shiftInfo(ids.Ben)?.clockedIn, true);

  const chi = await enroll(ids.Chi);
  const revoked = await call(`/api/presence/devices/${chi.deviceId}/revoke`, { method: "POST", headers: owner });
  assert.equal(revoked.status, 200);
  setPreviewNow(arriveTs);
  const dead = await postPhone(chi.token, "arrive", arriveTs, "chi-revoked-1");
  assert.equal(dead.status, 401);
  await queue(chi.token, { event: "arrive", trigger: "wifi", ts: arriveTs, eventId: "chi-revoked-1" });
  const ignored = await pollRelayOnce();
  assert.equal(ignored.rejected, 1);
  assert.equal(ignored.applied, 0);
  assert.equal(earnEngine.shiftInfo(ids.Chi)?.clockedIn ?? false, false);

  console.log("security ok");
} finally {
  stopRelayPoll();
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await new Promise<void>((resolve, reject) => mailbox.close((err) => (err ? reject(err) : resolve())));
}
