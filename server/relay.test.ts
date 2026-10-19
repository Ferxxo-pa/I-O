import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
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
import { hashDeviceToken } from "./presence/devices.ts";
import { mdnsAnswer } from "./lan/mdns.ts";
import { handleRelay, resetRelayLimits, type RelayDb, type RelayEnv } from "../relay/src/index.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-relay-"));
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
process.env.PRESENCE_DEVICE_HASH_PEPPER = "relay-pepper";
process.env.PRESENCE_SIGNAL_QUIET_MS = "900000";
process.env.PRESENCE_SIGNAL_RATE_PER_MIN = "1000";
process.env.PRESENCE_PHONE_MAX_AGE_MS = "600000";
process.env.LAN_BASE_URL = "http://io.local:5000";
process.env.RELAY_POLL_MS = "3600000";
process.env.RELAY_SHOP_SECRET = "shop-secret-test";

const sealKey = generateSealKey();
process.env.RELAY_SEAL_KEY = sealKey;
const shopSecret = process.env.RELAY_SHOP_SECRET;

type Box = { id: string; deviceKey: string; envelope: string; receivedAt: number; expiresAt: number };
const boxes: Box[] = [];
let pullDown = false;

const mailbox = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${shopSecret}`) {
    res.writeHead(401);
    res.end('{"ok":false}');
    return;
  }
  if (req.method === "GET" && req.url === "/pull") {
    if (pullDown) {
      res.writeHead(500);
      res.end('{"ok":false}');
      return;
    }
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
    const ids = new Set(((JSON.parse(raw) as { ids?: string[] }).ids ?? []));
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
const mailPort = typeof mailAddress === "object" && mailAddress ? mailAddress.port : 0;
process.env.RELAY_PUBLIC_URL = `http://127.0.0.1:${mailPort}`;

const { registerRoutes } = await import("./routes.ts");
const { earnEngine } = await import("./clock/engine.ts");
const { stopPresence, setPreviewNow, catchUpPresence } = await import("./presence/service.ts");
const { pollRelayOnce, stopRelayPoll } = await import("./relay/poll.ts");
const { healthReport } = await import("./ready.ts");

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

function memoryDb(): RelayDb & { rows: Array<Record<string, unknown>> } {
  const rows: Array<{ id: string; device_key: string; envelope: string; received_at: number; expires_at: number }> = [];
  return {
    rows,
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (text.startsWith("DELETE FROM boxes WHERE expires_at")) {
                const cut = Number(args[0]);
                for (let i = rows.length - 1; i >= 0; i--) if (rows[i].expires_at <= cut) rows.splice(i, 1);
              } else if (text.startsWith("INSERT")) {
                const [id, device_key, envelope, received_at, expires_at] = args as [string, string, string, number, number];
                if (!rows.some((row) => row.id === id)) rows.push({ id, device_key, envelope, received_at, expires_at });
              } else if (text.startsWith("DELETE FROM boxes WHERE id")) {
                const index = rows.findIndex((row) => row.id === String(args[0]));
                if (index >= 0) rows.splice(index, 1);
              }
              return { success: true };
            },
            async all<T>() {
              if (!text.startsWith("SELECT")) return { results: [] as T[] };
              const now = Number(args[0]);
              const results = rows
                .filter((row) => row.expires_at > now)
                .sort((a, b) => a.received_at - b.received_at)
                .slice(0, 50);
              return { results: results as T[] };
            },
          };
        },
      };
    },
  };
}

async function queue(token: string, payload: RelayPayload, envelope = "") {
  const key = await deviceKey(token);
  const material = await deviceSealMaterial(sealKey, key);
  const made = envelope ? null : await sealRelayBox(material, key, payload);
  const stored = envelope || made!.envelope;
  const box = made?.box ?? stored;
  const id = await mailboxId(key, box);
  const receivedAt = Date.now();
  boxes.push({
    id,
    deviceKey: key,
    envelope: stored,
    receivedAt,
    expiresAt: receivedAt + 72 * 60 * 60 * 1000,
  });
  return id;
}

try {
  const token = "io_phone_token_example";
  assert.equal(await deviceKey(token), hashDeviceToken(token).slice("sha256$".length));
  assert.equal(createHash("sha256").update(token).digest("hex"), await deviceKey(token));
  const sample: RelayPayload = { event: "leave", trigger: "geo", ts: 1_700_000_000_000, eventId: "1700000000000" };
  const material = await deviceSealMaterial(sealKey, await deviceKey(token));
  const sealed = await sealRelayBox(material, await deviceKey(token), sample);
  assert.equal(sealed.envelope.startsWith("v2."), true);
  assert.equal(sealed.envelope.includes("leave"), false);
  assert.deepEqual(await openRelayBox(material, await deviceKey(token), sealed.envelope), sample);
  const flipped = `${sealed.envelope.slice(0, -2)}${sealed.envelope.endsWith("A") ? "B" : "A"}`;
  assert.equal(await openRelayBox(material, await deviceKey(token), flipped), null);
  const packet = mdnsAnswer("io", "192.168.1.20");
  assert.equal(packet.includes(Buffer.from([192, 168, 1, 20])), true);
  assert.equal(packet.includes(Buffer.from("io")), true);

  const db = memoryDb();
  const env: RelayEnv = {
    DB: db,
    RELAY_SHOP_SECRET: shopSecret,
  };
  const drop = (body: unknown, authorization: string, now: number) =>
    handleRelay(
      new Request("https://relay.example/drop", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      now,
    );
  resetRelayLimits();
  const missing = await drop({ box: sealed.box, sig: sealed.sig }, "", 1_000);
  assert.equal(missing.status, 401);
  const wage = await drop({ box: sealed.box, sig: sealed.sig, hourlyCents: 2400 }, `Bearer ${token}`, 1_000);
  assert.equal(wage.status, 400);
  const plain = await drop(sample, `Bearer ${token}`, 1_000);
  assert.equal(plain.status, 400);
  assert.equal(db.rows.length, 0);
  const t0 = 1_700_000_100_000;
  const posted = await drop({ box: sealed.box, sig: sealed.sig }, `Bearer ${token}`, t0);
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { ok: true });
  const again = await drop({ box: sealed.box, sig: sealed.sig }, `Bearer ${token}`, t0 + 1);
  assert.equal(again.status, 200);
  assert.equal(db.rows.length, 1);
  const stored = JSON.stringify(db.rows);
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes("Ada"), false);
  assert.equal(stored.includes("wage"), false);
  assert.equal(stored.includes("square"), false);
  assert.equal(stored.includes('"event"'), false);
  assert.equal(db.rows[0].device_key, await deviceKey(token));
  assert.equal(String(db.rows[0].envelope).startsWith("v2."), true);
  assert.deepEqual(await openRelayBox(material, await deviceKey(token), String(db.rows[0].envelope)), sample);
  const stranger = await handleRelay(new Request("https://relay.example/pull", { headers: { authorization: "Bearer phone-token" } }), env, t0);
  assert.equal(stranger.status, 401);
  const pulled = await handleRelay(new Request("https://relay.example/pull", { headers: { authorization: `Bearer ${shopSecret}` } }), env, t0);
  const pulledBody = (await pulled.json()) as { messages: Array<{ envelope: string }> };
  assert.equal(pulledBody.messages.length, 1);
  const expired = await handleRelay(
    new Request("https://relay.example/pull", { headers: { authorization: `Bearer ${shopSecret}` } }),
    env,
    t0 + 72 * 60 * 60 * 1000 + 1,
  );
  assert.deepEqual(await expired.json(), { messages: [] });
  assert.equal(db.rows.length, 0);
  resetRelayLimits();
  for (let i = 0; i < 30; i++) {
    const next = await sealRelayBox(material, await deviceKey(token), { ...sample, eventId: `rate-id-${i}-ok` });
    const ok = await drop({ box: next.box, sig: next.sig }, `Bearer ${token}`, 5_000);
    assert.equal(ok.status, 200);
  }
  const limitedBox = await sealRelayBox(material, await deviceKey(token), { ...sample, eventId: "rate-limited" });
  const limited = await drop({ box: limitedBox.box, sig: limitedBox.sig }, `Bearer ${token}`, 5_000);
  assert.equal(limited.status, 429);

  setPreviewNow(at(9));
  const created = await call("/api/company", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "EZ Designs" }),
  });
  const ownerKey = created.body.ownerKey as string;
  const owner = { "content-type": "application/json", "x-owner-key": ownerKey };
  const ids: Record<string, string> = {};
  for (const name of ["Ada", "Ben", "Chi", "Nia", "Eve"]) {
    const added = await call("/api/company/people", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ name, hourlyCents: 2400 }),
    });
    ids[name] = (added.body.people as Array<{ id: string; name: string }>).find((person) => person.name === name)!.id;
    const consent = await call("/api/presence/consent", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ personId: ids[name], consent: true }),
    });
    assert.equal(consent.status, 200);
  }
  const setPin = await call("/api/fight/pin", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ pin: "2468" }),
  });
  assert.equal(setPin.status, 200);
  const shopPin = { "x-shop-pin": "2468" };

  async function enroll(name: string) {
    setPreviewNow(at(9));
    const setup = await call("/api/presence/phone/setup", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ personId: ids[name], label: `${name} phone` }),
    });
    assert.equal(setup.status, 200);
    assert.match(String(setup.body.inviteUrl), /^http:\/\/io\.local:5000\/join\//);
    const page = await fetch(`${base}${new URL(setup.body.inviteUrl as string).pathname}`);
    const html = await page.text();
    assert.match(html, new RegExp(`Setting up for ${name}`));
    assert.match(html, /cannot seal/);
    assert.equal(html.includes(sealKey), false);
    const opened = await call(`${new URL(setup.body.inviteUrl as string).pathname}/open`, { method: "POST" });
    assert.equal(opened.status, 200);
    return opened.body as {
      token: string;
      url: string;
      iphone: string;
      deviceSeal?: string;
      macro: { macros: Array<{ m_actionList: Array<{ m_url: string; m_body: string }> }> };
    };
  }

  const ada = await enroll("Ada");
  assert.equal(ada.url, "http://io.local:5000/api/presence/phone");
  assert.equal(ada.iphone.includes("POST http://io.local:5000/api/presence/phone"), true);
  const dropPosts = ada.iphone.split("\n").filter((line) => line.startsWith("POST ") && line.includes("/drop"));
  assert.equal(dropPosts.length, 0);
  assert.equal(ada.iphone.includes(`Mailbox POST http://127.0.0.1:${mailPort}/drop`), true);
  assert.equal(ada.iphone.includes("cannot seal"), true);
  assert.equal(typeof ada.deviceSeal, "string");
  assert.equal(ada.deviceSeal.length > 20, true);
  assert.equal(ada.iphone.includes(ada.deviceSeal), true);
  assert.equal(ada.iphone.includes(sealKey), false);
  const leaveNote = ada.iphone.split("\nLeave\n")[1]?.split("\nShop Wi-Fi")[0] ?? "";
  assert.equal(leaveNote.includes("/api/presence/phone"), true);
  assert.equal(leaveNote.includes("EVENT_ID"), true);
  assert.equal(ada.iphone.includes("Premiere"), true);
  const arriveMacro = ada.macro.macros[0];
  const leaveMacro = ada.macro.macros[1];
  assert.equal(arriveMacro.m_actionList.length, 1);
  assert.equal(arriveMacro.m_actionList[0].m_url, "http://io.local:5000/api/presence/phone");
  assert.equal(leaveMacro.m_actionList.length, 1);
  assert.equal(leaveMacro.m_actionList[0].m_url, "http://io.local:5000/api/presence/phone");
  assert.equal(leaveMacro.m_actionList[0].m_body.includes('"event":"leave"'), true);
  assert.equal(leaveMacro.m_actionList[0].m_body.includes("EVENT_ID"), true);
  assert.equal(JSON.stringify(ada.macro).includes(sealKey), false);

  async function postPhone(phone: string, event: "arrive" | "leave", trigger: "geo" | "wifi", ts: number, eventId: string) {
    return call("/api/presence/phone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${phone}` },
      body: JSON.stringify({ event, trigger, ts, eventId }),
    });
  }

  async function snapshot(personId: string) {
    const state = await call("/api/state", { headers: { "x-person-id": personId, ...shopPin } });
    return state.body as {
      session: { clockedIn: boolean; outputCents: number };
      events: Array<{ kind: string; createdAt: number }>;
    };
  }

  const arriveTs = at(9);
  const leaveTs = at(9, 30);
  const late = at(11);
  setPreviewNow(arriveTs);
  const adaArrive = await postPhone(ada.token, "arrive", "wifi", arriveTs, "ada-arrive-1");
  assert.equal(adaArrive.body.applied, "arrive");
  setPreviewNow(late);
  const staleLeave = await postPhone(ada.token, "leave", "geo", leaveTs, "ada-leave-cell");
  assert.equal(staleLeave.body.reason, "stale_signal");
  assert.equal((await snapshot(ids.Ada)).session.clockedIn, true);
  await queue(ada.token, { event: "leave", trigger: "geo", ts: leaveTs, eventId: "ada-leave-cell" });
  const cellular = await pollRelayOnce();
  assert.equal(cellular.applied, 1);
  assert.equal(boxes.length, 0);
  await catchUpPresence();
  const adaShift = earnEngine.shiftInfo(ids.Ada);
  const adaState = await snapshot(ids.Ada);
  assert.equal(adaShift?.clockedIn, false);
  assert.equal(adaShift?.outputCents, 1200);
  assert.equal(adaState.events.find((event) => event.kind === "clock_out")?.createdAt, leaveTs);

  const ben = await enroll("Ben");
  setPreviewNow(arriveTs);
  const benId = "ben-arrive-once";
  const ins = async () => (await snapshot(ids.Ben)).events.filter((event) => event.kind === "clock_in").length;
  const benBefore = await ins();
  const benLan = await postPhone(ben.token, "arrive", "wifi", arriveTs, benId);
  assert.equal(benLan.body.applied, "arrive");
  assert.equal(await ins(), benBefore + 1);
  await queue(ben.token, { event: "arrive", trigger: "wifi", ts: arriveTs, eventId: benId });
  const dupRelay = await pollRelayOnce();
  assert.equal(dupRelay.applied, 1);
  const benAgain = await postPhone(ben.token, "arrive", "geo", arriveTs, benId);
  assert.equal(benAgain.body.duplicate, true);
  assert.equal(await ins(), benBefore + 1);
  assert.equal((await snapshot(ids.Ben)).session.clockedIn, true);

  const chi = await enroll("Chi");
  setPreviewNow(arriveTs);
  await postPhone(chi.token, "arrive", "geo", arriveTs, "chi-arrive");
  await queue(chi.token, { event: "leave", trigger: "geo", ts: leaveTs, eventId: "chi-leave" });
  pullDown = true;
  setPreviewNow(late);
  const down = await pollRelayOnce();
  assert.equal(down.applied, 0);
  assert.equal(boxes.some((box) => box.id.length === 64), true);
  assert.equal((await snapshot(ids.Chi)).session.clockedIn, true);
  pullDown = false;
  const up = await pollRelayOnce();
  assert.equal(up.applied, 1);
  await catchUpPresence();
  const chiShift = earnEngine.shiftInfo(ids.Chi);
  const chiState = await snapshot(ids.Chi);
  assert.equal(chiShift?.clockedIn, false);
  assert.equal(chiShift?.outputCents, 1200);
  assert.equal(chiState.events.find((event) => event.kind === "clock_out")?.createdAt, leaveTs);

  const nia = await enroll("Nia");
  stopRelayPoll();
  await queue(nia.token, { event: "arrive", trigger: "wifi", ts: arriveTs, eventId: "nia-arrive" });
  await queue(nia.token, { event: "leave", trigger: "geo", ts: leaveTs, eventId: "nia-leave" });
  setPreviewNow(late);
  assert.equal((await snapshot(ids.Nia)).session.clockedIn, false);
  const niaKey = await deviceKey(nia.token);
  assert.equal(boxes.filter((box) => box.deviceKey === niaKey).length, 2);
  const returned = await pollRelayOnce();
  assert.equal(returned.applied, 2);
  await catchUpPresence();
  const niaShift = earnEngine.shiftInfo(ids.Nia);
  const niaState = await snapshot(ids.Nia);
  assert.equal(niaShift?.clockedIn, false);
  assert.equal(niaShift?.outputCents, 1200);
  assert.equal(niaState.events.find((event) => event.kind === "clock_in")?.createdAt, arriveTs);
  assert.equal(niaState.events.find((event) => event.kind === "clock_out")?.createdAt, leaveTs);

  const eve = await enroll("Eve");
  setPreviewNow(arriveTs);
  await postPhone(eve.token, "arrive", "wifi", arriveTs, "eve-arrive");
  const eveMaterial = await deviceSealMaterial(sealKey, await deviceKey(eve.token));
  const tamper = await sealRelayBox(eveMaterial, await deviceKey(eve.token), {
    event: "leave",
    trigger: "geo",
    ts: leaveTs,
    eventId: "eve-tamper",
  });
  const flippedEve = `${tamper.envelope.slice(0, -2)}${tamper.envelope.endsWith("A") ? "B" : "A"}`;
  await queue(eve.token, { event: "leave", trigger: "geo", ts: leaveTs, eventId: "eve-tamper" }, flippedEve);
  await queue(eve.token, { event: "leave", trigger: "geo", ts: leaveTs, eventId: "eve-plain" }, "v2.not-a-box.not-a-sig");
  setPreviewNow(late);
  const rejected = await pollRelayOnce();
  assert.equal(rejected.rejected, 2);
  assert.equal(rejected.applied, 0);
  const eveInfo = earnEngine.shiftInfo(ids.Eve);
  assert.equal(eveInfo?.clockedIn, true);
  assert.equal(eveInfo?.holdAt ?? null, null);
  const eveKey = await deviceKey(eve.token);
  assert.equal(boxes.filter((box) => box.deviceKey === eveKey).length, 0);

  const health = await healthReport();
  const webhook = health.checks.find((row) => row.id === "webhook");
  const lan = health.checks.find((row) => row.id === "public_url");
  assert.equal(webhook?.ok, true);
  assert.equal(webhook?.note, "Square is polled. Webhooks are off.");
  assert.equal(lan?.label, "Shop LAN");
  assert.equal(lan?.ok, true);
  assert.equal(lan?.note, "io.local:5000");

  console.log("relay ok");
} finally {
  stopRelayPoll();
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await new Promise<void>((resolve, reject) => mailbox.close((err) => (err ? reject(err) : resolve())));
}
