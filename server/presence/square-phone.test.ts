import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request } from "express";
import { shopDateStart } from "@shared/presence.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-square-phone-"));
process.env.SQUARE_ACCESS_TOKEN = "test-square-token";
process.env.SQUARE_LOCATION_ID = "LOC1";
delete process.env.SQUARE_PRESENCE_MIRROR;
delete process.env.PRESENCE_DESK_TOKEN;
delete process.env.SHOP_PIN;
process.env.NODE_ENV = "development";
process.env.IO_MODE = "public";
process.env.IO_MDNS = "0";
delete process.env.RELAY_PUBLIC_URL;
process.env.PRESENCE_PREVIEW = "1";
process.env.PRESENCE_PUBLIC_URL = "https://shop.example";
process.env.PRESENCE_DEVICE_HASH_PEPPER = "square-phone-pepper";
process.env.PRESENCE_SIGNAL_QUIET_MS = "60000";
process.env.PRESENCE_SIGNAL_RATE_PER_MIN = "1000";

type Member = {
  id: string;
  status: "ACTIVE" | "INACTIVE";
  given_name: string;
  family_name: string;
  locationIds: string[];
  hourlyCents: number;
  title: string;
  is_owner?: boolean;
};

const members = new Map<string, Member>([
  ["TM_ADA", { id: "TM_ADA", status: "ACTIVE", given_name: "Ada", family_name: "", locationIds: ["LOC1"], hourlyCents: 2400, title: "Print", is_owner: true }],
  ["TM_BEN", { id: "TM_BEN", status: "ACTIVE", given_name: "Ben", family_name: "", locationIds: ["LOC1"], hourlyCents: 3600, title: "Bind" }],
  ["TM_NIA", { id: "TM_NIA", status: "INACTIVE", given_name: "Nia", family_name: "", locationIds: ["LOC1"], hourlyCents: 2000, title: "Cut" }],
  ["TM_GIL", { id: "TM_GIL", status: "ACTIVE", given_name: "Gil", family_name: "", locationIds: ["LOC_OTHER"], hourlyCents: 2200, title: "Ship" }],
]);

type Card = {
  id: string;
  version: number;
  status: string;
  team_member_id: string;
  location_id: string;
  start_at: string;
  end_at?: string;
  wage?: unknown;
};

const openCards = new Map<string, Card>();
const calls: Array<{ method: string; path: string; body: unknown }> = [];

function memberBody(member: Member) {
  return {
    id: member.id,
    status: member.status,
    given_name: member.given_name,
    family_name: member.family_name,
    is_owner: Boolean(member.is_owner),
    assigned_locations: { assignment_type: "EXPLICIT_LOCATIONS", location_ids: member.locationIds },
  };
}

const realFetch = global.fetch;
global.fetch = async (input, init) => {
  const url = String(input);
  if (!url.includes("squareup.com")) return realFetch(input, init);
  const path = new URL(url).pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ method, path, body });
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  if (path === "/v2/team-members/search" && method === "POST") {
    const status = (body as { query?: { filter?: { status?: string } } })?.query?.filter?.status ?? "ACTIVE";
    return json({ team_members: [...members.values()].filter((member) => member.status === status).map(memberBody) });
  }
  const wage = path.match(/^\/v2\/team-members\/([^/]+)\/wage-setting$/);
  if (wage && method === "GET") {
    const member = members.get(decodeURIComponent(wage[1]));
    if (!member) return json({ errors: [{ detail: "missing" }] }, 404);
    return json({
      wage_setting: {
        job_assignments: [
          {
            job_title: member.title,
            pay_type: "HOURLY",
            hourly_rate: { amount: member.hourlyCents, currency: "USD" },
            tip_eligible: false,
          },
        ],
      },
    });
  }
  const memberPath = path.match(/^\/v2\/team-members\/([^/]+)$/);
  if (memberPath && method === "GET") {
    const member = members.get(decodeURIComponent(memberPath[1]));
    if (!member) return json({ errors: [{ detail: "missing" }] }, 404);
    return json({ team_member: memberBody(member) });
  }
  if (path === "/v2/labor/timecards/search" && method === "POST") {
    const ids = ((body as { query?: { filter?: { team_member_ids?: string[] } } })?.query?.filter?.team_member_ids ?? []) as string[];
    const timecards = [...openCards.values()].filter(
      (card) => card.status === "OPEN" && (ids.length === 0 || ids.includes(card.team_member_id)),
    );
    return json({ timecards });
  }
  if (path === "/v2/labor/timecards" && method === "POST") {
    const team = (body as { timecard: { team_member_id: string; location_id: string; start_at: string; wage?: unknown } }).timecard;
    const id = `card-${team.team_member_id}`;
    openCards.set(team.team_member_id, {
      id,
      version: 1,
      status: "OPEN",
      team_member_id: team.team_member_id,
      location_id: team.location_id,
      start_at: team.start_at,
      wage: team.wage,
    });
    return json({ timecard: { id } });
  }
  const cardPath = path.match(/^\/v2\/labor\/timecards\/([^/]+)$/);
  if (cardPath && method === "GET") {
    const card = [...openCards.values()].find((entry) => entry.id === decodeURIComponent(cardPath[1]));
    if (!card) return json({ errors: [{ detail: "missing" }] }, 404);
    return json({ timecard: card });
  }
  if (cardPath && method === "PUT") {
    const card = [...openCards.values()].find((entry) => entry.id === decodeURIComponent(cardPath[1]));
    if (!card) return json({ errors: [{ detail: "missing" }] }, 404);
    const next = (body as { timecard: Card["status"] & { team_member_id?: string; end_at?: string; status?: string } }).timecard;
    card.status = next.status ?? "CLOSED";
    card.end_at = next.end_at;
    card.version += 1;
    return json({ timecard: card });
  }
  if (path === "/v2/invoices/search") return json({ invoices: [] });
  if (path === "/v2/locations") return json({ locations: [{ id: "LOC1", status: "ACTIVE" }] });
  return json({ errors: [{ detail: `unmocked ${method} ${path}` }] }, 500);
};

const { registerRoutes } = await import("../routes.ts");
const { earnEngine } = await import("../clock/engine.ts");
const { setPreviewNow, catchUpPresence, stopPresence } = await import("./service.ts");

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

const start = shopDateStart("2026-10-14");
const at = (hours: number, minutes = 0) => start + (hours * 60 + minutes) * 60_000;

function phone(token: string, event: "arrive" | "leave", trigger: "geo" | "wifi", ts: number, extra?: Record<string, string>) {
  return call("/api/presence/phone", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ event, trigger, ts, ...extra }),
  });
}

function creates() {
  return calls.filter((call) => call.method === "POST" && call.path === "/v2/labor/timecards");
}

try {
  setPreviewNow(at(9));
  const created = await call("/api/company", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "EZ Designs" }),
  });
  const ownerKey = created.body.ownerKey as string;
  const headers = { "content-type": "application/json", "x-owner-key": ownerKey };
  assert.equal(created.body.shop.wifiSsid, "Premiere");

  async function setup(personId: string) {
    return call("/api/presence/phone/setup", {
      method: "POST",
      headers,
      body: JSON.stringify({ personId, label: "phone" }),
    });
  }
  const adaSetup = await setup("TM_ADA");
  const benSetup = await setup("TM_BEN");
  assert.equal(adaSetup.status, 200);
  assert.equal(adaSetup.body.personId, "TM_ADA");
  assert.equal(adaSetup.body.name, "Ada");
  assert.equal(adaSetup.body.squareTeamMemberId, "TM_ADA");
  assert.equal(adaSetup.body.squareLocationId, "LOC1");
  assert.equal(JSON.stringify(adaSetup.body).includes("hourly"), false);
  assert.equal(benSetup.body.squareTeamMemberId, "TM_BEN");
  const adaToken = (await call(`${new URL(adaSetup.body.inviteUrl as string).pathname}/open`, { method: "POST" })).body.token as string;
  const benToken = (await call(`${new URL(benSetup.body.inviteUrl as string).pathname}/open`, { method: "POST" })).body.token as string;

  const nia = await setup("TM_NIA");
  assert.equal(nia.status, 409);
  assert.equal(nia.body.reason, "deactivated");
  assert.equal(nia.body.flag, "deactivated");
  const gil = await setup("TM_GIL");
  assert.equal(gil.status, 409);
  assert.equal(gil.body.reason, "unassigned");

  for (const personId of ["TM_ADA", "TM_BEN"]) {
    const consent = await call("/api/presence/consent", {
      method: "POST",
      headers,
      body: JSON.stringify({ personId, consent: true }),
    });
    assert.equal(consent.status, 200);
  }

  openCards.set("TM_ADA", {
    id: "card-ada-pos",
    version: 3,
    status: "OPEN",
    team_member_id: "TM_ADA",
    location_id: "LOC1",
    start_at: new Date(at(8)).toISOString(),
  });
  const before = creates().length;
  const adaIn = await phone(adaToken, "arrive", "geo", at(9));
  assert.equal(adaIn.body.applied, "arrive");
  assert.equal(creates().length, before);
  const adaState = await call("/api/state", { headers: { "x-person-id": "TM_ADA" } });
  assert.equal(adaState.body.session.clockedIn, true);
  assert.equal(adaState.body.session.externalShiftId, "card-ada-pos");
  const adaWork = await call("/api/presence/state/TM_ADA", { headers });
  assert.equal(adaWork.body.source, "phone-geo");

  setPreviewNow(at(9, 5));
  const adaAgain = await phone(adaToken, "arrive", "wifi", at(9, 5));
  assert.equal(adaAgain.body.applied, "seen");
  assert.equal(creates().length, before);

  const crossed = await phone(adaToken, "arrive", "geo", at(9, 5), { personId: "TM_BEN" });
  assert.equal(crossed.status, 400);
  assert.equal(creates().filter((call) => (call.body as { timecard?: { team_member_id?: string } })?.timecard?.team_member_id === "TM_BEN").length, 0);

  members.get("TM_BEN")!.status = "INACTIVE";
  setPreviewNow(at(9, 6));
  const benIn = await phone(benToken, "arrive", "geo", at(9, 6));
  assert.equal(benIn.body.applied, "rejected");
  assert.equal(benIn.body.reason, "deactivated");
  assert.equal(creates().some((call) => (call.body as { timecard?: { team_member_id?: string } })?.timecard?.team_member_id === "TM_BEN"), false);
  const devices = await call("/api/presence/devices", { headers });
  const benDevice = (devices.body.devices as Array<{ personId: string; squareFlag: string | null; squareTeamMemberId: string }>).find(
    (device) => device.personId === "TM_BEN",
  );
  assert.equal(benDevice?.squareFlag, "deactivated");
  assert.equal(benDevice?.squareTeamMemberId, "TM_BEN");
  const benState = await call("/api/state", { headers: { "x-person-id": "TM_BEN" } });
  assert.equal(benState.body.session.clockedIn, false);

  members.get("TM_BEN")!.status = "ACTIVE";
  setPreviewNow(at(10));
  const benOpen = await phone(benToken, "arrive", "geo", at(10));
  assert.equal(benOpen.body.applied, "arrive");
  const benCreates = creates().filter(
    (call) => (call.body as { timecard?: { team_member_id?: string } })?.timecard?.team_member_id === "TM_BEN",
  );
  assert.equal(benCreates.length, 1);
  const benCard = (benCreates[0].body as { timecard: { location_id: string; wage: { title: string; hourly_rate: { amount: number } } } }).timecard;
  assert.equal(benCard.location_id, "LOC1");
  assert.equal(benCard.wage.title, "Bind");
  assert.equal(benCard.wage.hourly_rate.amount, 3600);
  assert.equal(creates().some((call) => (call.body as { timecard?: { team_member_id?: string } })?.timecard?.team_member_id === "TM_ADA"), false);
  assert.equal(calls.some((call) => call.path.includes("wage-setting") && call.method !== "GET"), false);
  const benShift = await call("/api/state", { headers: { "x-person-id": "TM_BEN" } });
  assert.equal(benShift.body.session.externalShiftId, "card-TM_BEN");
  assert.equal(adaState.body.session.externalShiftId, "card-ada-pos");

  setPreviewNow(at(10, 10));
  const adaLeave = await phone(adaToken, "leave", "geo", at(10, 10));
  assert.equal(adaLeave.body.applied, "exit");
  setPreviewNow(at(10, 12));
  await catchUpPresence();
  const closes = calls.filter((call) => call.method === "PUT" && call.path.startsWith("/v2/labor/timecards/"));
  assert.equal(closes.length, 1);
  assert.equal(closes[0].path, "/v2/labor/timecards/card-ada-pos");
  assert.equal((closes[0].body as { timecard: { team_member_id: string } }).timecard.team_member_id, "TM_ADA");
  assert.equal(openCards.get("TM_BEN")?.status, "OPEN");
  const adaOut = await call("/api/state", { headers: { "x-person-id": "TM_ADA" } });
  assert.equal(adaOut.body.session.clockedIn, false);
  const benStill = await call("/api/state", { headers: { "x-person-id": "TM_BEN" } });
  assert.equal(benStill.body.session.clockedIn, true);
} finally {
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("square phone ok");
