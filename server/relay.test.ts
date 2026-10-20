import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { shopDateStart } from "@shared/presence.ts";
import { deviceKey, hookId, mailboxId, parseRelayPayload, thinSquareHook, type RelayPayload } from "@shared/relayBox.ts";
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

const shopSecret = process.env.RELAY_SHOP_SECRET;

type Box = {
  id: string;
  deviceKey: string;
  event: string;
  trigger: string;
  ts: number;
  eventId: string;
  receivedAt: number;
  expiresAt: number;
};
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
        event: box.event,
        trigger: box.trigger,
        ts: box.ts,
        eventId: box.eventId,
        receivedAt: box.receivedAt,
      })),
      hooks: [],
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

type StoredBox = {
  id: string;
  device_key: string;
  event: string;
  trigger: string;
  ts: number;
  event_id: string;
  received_at: number;
  expires_at: number;
};
type StoredHook = {
  id: string;
  kind: string;
  entity_id: string;
  team_member_id: string;
  ts: number;
  received_at: number;
  expires_at: number;
};

function memoryDb(): RelayDb & { rows: StoredBox[]; hooks: StoredHook[] } {
  const rows: StoredBox[] = [];
  const hooks: StoredHook[] = [];
  return {
    rows,
    hooks,
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      const hookTable = text.includes("hooks");
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (text.startsWith("DELETE FROM boxes WHERE expires_at")) {
                const cut = Number(args[0]);
                for (let i = rows.length - 1; i >= 0; i--) if (rows[i].expires_at <= cut) rows.splice(i, 1);
              } else if (text.startsWith("DELETE FROM hooks WHERE expires_at")) {
                const cut = Number(args[0]);
                for (let i = hooks.length - 1; i >= 0; i--) if (hooks[i].expires_at <= cut) hooks.splice(i, 1);
              } else if (text.startsWith("INSERT") && hookTable) {
                const [id, kind, entity_id, team_member_id, ts, received_at, expires_at] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  number,
                ];
                if (!hooks.some((row) => row.id === id)) {
                  hooks.push({ id, kind, entity_id, team_member_id, ts, received_at, expires_at });
                }
              } else if (text.startsWith("INSERT")) {
                const [id, device_key, event, trigger, ts, event_id, received_at, expires_at] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  string,
                  number,
                  number,
                ];
                if (!rows.some((row) => row.id === id)) {
                  rows.push({ id, device_key, event, trigger, ts, event_id, received_at, expires_at });
                }
              } else if (text.startsWith("DELETE FROM boxes WHERE id")) {
                const index = rows.findIndex((row) => row.id === String(args[0]));
                if (index >= 0) rows.splice(index, 1);
              } else if (text.startsWith("DELETE FROM hooks WHERE id")) {
                const index = hooks.findIndex((row) => row.id === String(args[0]));
                if (index >= 0) hooks.splice(index, 1);
              }
              return { success: true };
            },
            async all<T>() {
              if (!text.startsWith("SELECT")) return { results: [] as T[] };
              const now = Number(args[0]);
              if (hookTable) {
                const results = hooks.filter((row) => row.expires_at > now).sort((a, b) => a.received_at - b.received_at).slice(0, 50);
                return { results: results as T[] };
              }
              const results = rows.filter((row) => row.expires_at > now).sort((a, b) => a.received_at - b.received_at).slice(0, 50);
              return { results: results as T[] };
            },
          };
        },
      };
    },
  };
}

async function queue(token: string, payload: RelayPayload) {
  const parsed = parseRelayPayload(payload);
  if (!parsed) throw new Error("bad payload");
  const key = await deviceKey(token);
  const receivedAt = Date.now();
  boxes.push({
    id: await mailboxId(key, parsed.eventId),
    deviceKey: key,
    event: parsed.event,
    trigger: parsed.trigger,
    ts: parsed.ts,
    eventId: parsed.eventId,
    receivedAt,
    expiresAt: receivedAt + 72 * 60 * 60 * 1000,
  });
}

function queueBad(tokenKey: string, eventId: string) {
  const receivedAt = Date.now();
  boxes.push({
    id: eventId.padEnd(64, "a").slice(0, 64),
    deviceKey: tokenKey,
    event: "nope",
    trigger: "geo",
    ts: 1,
    eventId,
    receivedAt,
    expiresAt: receivedAt + 72 * 60 * 60 * 1000,
  });
}

try {
  const token = "io_phone_token_example";
  assert.equal(await deviceKey(token), hashDeviceToken(token).slice("sha256$".length));
  assert.equal(createHash("sha256").update(token).digest("hex"), await deviceKey(token));
  const sample: RelayPayload = { event: "leave", trigger: "geo", ts: 1_700_000_000_000, eventId: "1700000000000" };
  assert.deepEqual(parseRelayPayload(sample), sample);
  assert.equal(parseRelayPayload({ ...sample, hourlyCents: 2400 }), null);
  assert.equal(parseRelayPayload({ event: "tap", trigger: "geo", ts: sample.ts, eventId: sample.eventId }), null);
  assert.deepEqual(parseRelayPayload({ event: "tap", trigger: "nfc", ts: sample.ts, eventId: "nfc-tap-01" }), {
    event: "tap",
    trigger: "nfc",
    ts: sample.ts,
    eventId: "nfc-tap-01",
  });
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
  const missing = await drop(sample, "", 1_000);
  assert.equal(missing.status, 401);
  const wage = await drop({ ...sample, hourlyCents: 2400 }, `Bearer ${token}`, 1_000);
  assert.equal(wage.status, 400);
  const sealedShape = await drop({ box: "abc", sig: "def" }, `Bearer ${token}`, 1_000);
  assert.equal(sealedShape.status, 400);
  assert.equal(db.rows.length, 0);
  const t0 = 1_700_000_100_000;
  const posted = await drop(sample, `Bearer ${token}`, t0);
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { ok: true });
  const again = await drop(sample, `Bearer ${token}`, t0 + 1);
  assert.equal(again.status, 200);
  assert.equal(db.rows.length, 1);
  const stored = JSON.stringify(db.rows);
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes("Ada"), false);
  assert.equal(stored.includes("wage"), false);
  assert.equal(stored.includes("hourly"), false);
  assert.equal(stored.includes("access_token"), false);
  assert.equal(db.rows[0].device_key, await deviceKey(token));
  assert.equal(db.rows[0].event, "leave");
  assert.equal(db.rows[0].id, await mailboxId(await deviceKey(token), sample.eventId));
  const stranger = await handleRelay(new Request("https://relay.example/pull", { headers: { authorization: "Bearer phone-token" } }), env, t0);
  assert.equal(stranger.status, 401);
  const pulled = await handleRelay(new Request("https://relay.example/pull", { headers: { authorization: `Bearer ${shopSecret}` } }), env, t0);
  const pulledBody = (await pulled.json()) as { messages: Array<{ event: string; eventId: string }>; hooks: unknown[] };
  assert.equal(pulledBody.messages.length, 1);
  assert.equal(pulledBody.messages[0].event, "leave");
  assert.equal(pulledBody.hooks.length, 0);
  const expired = await handleRelay(
    new Request("https://relay.example/pull", { headers: { authorization: `Bearer ${shopSecret}` } }),
    env,
    t0 + 72 * 60 * 60 * 1000 + 1,
  );
  assert.deepEqual(await expired.json(), { messages: [], hooks: [] });
  assert.equal(db.rows.length, 0);
  const squareOff = await handleRelay(new Request("https://relay.example/square", { method: "POST", body: "{}" }), env, t0);
  assert.equal(squareOff.status, 404);
  const hookBody = JSON.stringify({
    type: "labor.timecard.created",
    created_at: "2026-10-14T14:00:00Z",
    data: {
      id: "tc-ada",
      object: { timecard: { id: "tc-ada", team_member_id: "TMADA", given_name: "Ada", hourly_rate: { amount: 2400 } } },
    },
  });
  const thin = thinSquareHook(JSON.parse(hookBody), t0);
  assert.equal(thin?.entityId, "tc-ada");
  assert.equal(thin?.teamMemberId, "TMADA");
  assert.equal(JSON.stringify(thin).includes("Ada"), false);
  assert.equal(JSON.stringify(thin).includes("2400"), false);
  env.RELAY_SQUARE_WEBHOOK_KEY = "square-sign-key";
  env.RELAY_SQUARE_NOTIFICATION_URL = "https://relay.example/square";
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", "square-sign-key").update(`https://relay.example/square${hookBody}`).digest("base64");
  const hooked = await handleRelay(
    new Request("https://relay.example/square", {
      method: "POST",
      headers: { "x-square-hmacsha256-signature": sig },
      body: hookBody,
    }),
    env,
    t0,
  );
  assert.equal(hooked.status, 200);
  assert.equal(db.hooks.length, 1);
  const hookStored = JSON.stringify(db.hooks);
  assert.equal(hookStored.includes("Ada"), false);
  assert.equal(hookStored.includes("2400"), false);
  assert.equal(hookStored.includes("hourly"), false);
  assert.equal(db.hooks[0].id, await hookId("labor.timecard.created", "tc-ada", Date.parse("2026-10-14T14:00:00Z")));
  resetRelayLimits();
  for (let i = 0; i < 30; i++) {
    const ok = await drop({ ...sample, eventId: `rate-id-${i}-ok` }, `Bearer ${token}`, 5_000);
    assert.equal(ok.status, 200);
  }
  const limited = await drop({ ...sample, eventId: "rate-limited" }, `Bearer ${token}`, 5_000);
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
    assert.match(html, /cellular leave/);
    assert.equal(html.includes("cannot seal"), false);
    const opened = await call(`${new URL(setup.body.inviteUrl as string).pathname}/open`, { method: "POST" });
    assert.equal(opened.status, 200);
    return opened.body as {
      token: string;
      url: string;
      iphone: string;
      macro: { macros: Array<{ m_actionList: Array<{ m_url: string; m_body: string }> }> };
    };
  }

  const ada = await enroll("Ada");
  assert.equal(ada.url, "http://io.local:5000/api/presence/phone");
  assert.equal(ada.iphone.includes("POST http://io.local:5000/api/presence/phone"), true);
  const dropPosts = ada.iphone.split("\n").filter((line) => line.startsWith("POST ") && line.includes("/drop"));
  assert.equal(dropPosts.length > 0, true);
  assert.equal(ada.iphone.includes("cannot seal"), false);
  assert.equal(ada.iphone.includes("seal"), false);
  const leaveNote = ada.iphone.split("\nLeave\n")[1]?.split("\nShop Wi-Fi")[0] ?? "";
  assert.equal(leaveNote.includes("/api/presence/phone"), false);
  assert.equal(leaveNote.includes(`/drop`), true);
  assert.equal(leaveNote.includes("EVENT_ID"), true);
  assert.equal(ada.iphone.includes("NFC tag"), true);
  assert.equal(ada.iphone.includes('"trigger":"nfc"'), true);
  assert.equal(ada.iphone.includes("Premiere"), true);
  const arriveMacro = ada.macro.macros[0];
  const leaveMacro = ada.macro.macros[1];
  assert.equal(arriveMacro.m_actionList.length, 2);
  assert.equal(arriveMacro.m_actionList[0].m_url, "http://io.local:5000/api/presence/phone");
  assert.equal(arriveMacro.m_actionList[1].m_url, `http://127.0.0.1:${mailPort}/drop`);
  assert.equal(leaveMacro.m_actionList.length, 1);
  assert.equal(leaveMacro.m_actionList[0].m_url, `http://127.0.0.1:${mailPort}/drop`);
  assert.equal(leaveMacro.m_actionList[0].m_body.includes('"event":"leave"'), true);
  assert.equal(leaveMacro.m_actionList[0].m_body.includes("EVENT_ID"), true);
  assert.equal(JSON.stringify(ada.macro).includes("box"), false);

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
  queueBad(await deviceKey(eve.token), "eve-bad-event");
  queueBad(await deviceKey(eve.token), "eve-bad-other");
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
