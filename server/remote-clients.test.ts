import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { shopDateStart } from "@shared/presence.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-remote-"));
process.env.SQUARE_ACCESS_TOKEN = "test-square-token";
process.env.SQUARE_LOCATION_ID = "LOC1";
delete process.env.SQUARE_PRESENCE_MIRROR;
delete process.env.SQUARE_TEAM_MEMBER_ID;
delete process.env.PRESENCE_DESK_TOKEN;
delete process.env.SHOP_PIN;
delete process.env.IO_CORS_ORIGINS;
process.env.NODE_ENV = "development";
process.env.IO_MODE = "public";
process.env.IO_MDNS = "0";
delete process.env.RELAY_PUBLIC_URL;
process.env.PRESENCE_PREVIEW = "1";
process.env.PRESENCE_PUBLIC_URL = "https://shop.example";
process.env.PRESENCE_DEVICE_HASH_PEPPER = "remote-client-pepper";
process.env.PRESENCE_SIGNAL_QUIET_MS = "900000";
process.env.PRESENCE_SIGNAL_RATE_PER_MIN = "1000";

type Member = {
  id: string;
  status: "ACTIVE" | "INACTIVE";
  given_name: string;
  locationIds: string[];
  hourlyCents: number;
  title: string;
  is_owner?: boolean;
};

const members = new Map<string, Member>([
  ["TM_ADA", { id: "TM_ADA", status: "ACTIVE", given_name: "Ada", locationIds: ["LOC1"], hourlyCents: 2400, title: "Print", is_owner: true }],
  ["TM_BEN", { id: "TM_BEN", status: "ACTIVE", given_name: "Ben", locationIds: ["LOC1"], hourlyCents: 3600, title: "Bind" }],
]);

type Card = {
  id: string;
  version: number;
  status: string;
  team_member_id: string;
  location_id: string;
  start_at: string;
};

const openCards = new Map<string, Card>();
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let createDelayMs = 0;

function memberBody(member: Member) {
  return {
    id: member.id,
    status: member.status,
    given_name: member.given_name,
    family_name: "",
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
    if (createDelayMs) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
    const team = (body as { timecard: { team_member_id: string; location_id: string; start_at: string } }).timecard;
    const id = `card-${team.team_member_id}`;
    openCards.set(team.team_member_id, {
      id,
      version: 1,
      status: "OPEN",
      team_member_id: team.team_member_id,
      location_id: team.location_id,
      start_at: team.start_at,
    });
    return json({ timecard: { id } });
  }
  if (path === "/v2/invoices/search") return json({ invoices: [] });
  if (path === "/v2/locations") return json({ locations: [{ id: "LOC1", status: "ACTIVE" }] });
  return json({ errors: [{ detail: `unmocked ${method} ${path}` }] }, 500);
};

const { installRemoteCors } = await import("./http/cors.ts");
const { registerRoutes } = await import("./routes.ts");
const { earnEngine } = await import("./clock/engine.ts");
const { setPreviewNow, stopPresence } = await import("./presence/service.ts");

const app = express();
installRemoteCors(app);
app.use(express.json());
const server = await registerRoutes(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { status: res.status, body, headers: res.headers };
}

const start = shopDateStart("2026-10-14");
const at = (hours: number, minutes = 0) => start + (hours * 60 + minutes) * 60_000;

function createsFor(teamMemberId: string) {
  return calls.filter((entry) => {
    if (entry.method !== "POST" || entry.path !== "/v2/labor/timecards") return false;
    return (entry.body as { timecard?: { team_member_id?: string } })?.timecard?.team_member_id === teamMemberId;
  });
}

try {
  setPreviewNow(at(9));
  const created = await call("/api/company", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "EZ Designs" }),
  });
  assert.equal(created.status, 200);
  const ownerKey = created.body.ownerKey as string;
  const owner = { "content-type": "application/json", "x-owner-key": ownerKey };

  const desk = "https://ada-pc.example";
  const laptop = "https://ada-laptop.example";
  const preflight = await call("/api/clock/in", {
    method: "OPTIONS",
    headers: {
      origin: desk,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-shop-pin,x-person-id,authorization",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), desk);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-shop-pin/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

  process.env.IO_CORS_ORIGINS = "https://allowed.example";
  const blockedOrigin = await call("/api/clock/in", {
    method: "OPTIONS",
    headers: { origin: desk, "access-control-request-method": "POST" },
  });
  assert.equal(blockedOrigin.headers.get("access-control-allow-origin"), null);
  delete process.env.IO_CORS_ORIGINS;

  const noPin = await call("/api/clock/in", {
    method: "POST",
    headers: { "content-type": "application/json", origin: desk, "x-person-id": "TM_ADA" },
    body: JSON.stringify({ personId: "TM_ADA" }),
  });
  assert.equal(noPin.status, 403);
  assert.equal(noPin.headers.get("access-control-allow-origin"), desk);

  const setPin = await call("/api/fight/pin", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ pin: "2468" }),
  });
  assert.equal(setPin.status, 200);

  const wrong = await call("/api/clock/in", {
    method: "POST",
    headers: { "content-type": "application/json", origin: desk, "x-shop-pin": "0000", "x-person-id": "TM_ADA" },
    body: JSON.stringify({ personId: "TM_ADA" }),
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("access-control-allow-origin"), desk);

  const mismatch = await call("/api/clock/in", {
    method: "POST",
    headers: { "content-type": "application/json", origin: desk, "x-shop-pin": "2468", "x-person-id": "TM_ADA" },
    body: JSON.stringify({ personId: "TM_BEN" }),
  });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.message, "This computer is linked to someone else");
  assert.equal(createsFor("TM_BEN").length, 0);
  assert.equal(createsFor("TM_ADA").length, 0);

  const setup = await call("/api/presence/phone/setup", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ personId: "TM_ADA", label: "phone" }),
  });
  assert.equal(setup.status, 200);
  const opened = await call(`${new URL(setup.body.inviteUrl as string).pathname}/open`, { method: "POST" });
  assert.equal(opened.status, 200);
  const token = opened.body.token as string;
  const consent = await call("/api/presence/consent", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ personId: "TM_ADA", consent: true }),
  });
  assert.equal(consent.status, 200);

  createDelayMs = 200;
  const pin = (personId: string, origin: string) => ({
    "content-type": "application/json",
    origin,
    "x-shop-pin": "2468",
    "x-person-id": personId,
  });
  const [deskIn, laptopIn, phoneIn] = await Promise.all([
    call("/api/clock/in", {
      method: "POST",
      headers: pin("TM_ADA", desk),
      body: JSON.stringify({ personId: "TM_ADA" }),
    }),
    call("/api/clock/in", {
      method: "POST",
      headers: pin("TM_ADA", laptop),
      body: JSON.stringify({ personId: "TM_ADA" }),
    }),
    call("/api/presence/phone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: "arrive", trigger: "geo", ts: at(9) }),
    }),
  ]);
  assert.equal(deskIn.status, 200);
  assert.equal(laptopIn.status, 200);
  assert.equal(deskIn.headers.get("access-control-allow-origin"), desk);
  assert.equal(laptopIn.headers.get("access-control-allow-origin"), laptop);
  assert.equal(phoneIn.status, 200);
  assert.ok(phoneIn.body.applied === "arrive" || phoneIn.body.applied === "seen");
  assert.equal(createsFor("TM_ADA").length, 1);
  assert.equal(createsFor("TM_BEN").length, 0);

  const ada = await call("/api/state", { headers: { "x-person-id": "TM_ADA" } });
  assert.equal(ada.body.session.clockedIn, true);
  assert.equal(ada.body.session.externalShiftId, "card-TM_ADA");
  const ins = (ada.body.events as Array<{ kind: string }>).filter((event) => event.kind === "clock_in");
  assert.equal(ins.length, 1);
  const ben = await call("/api/state", { headers: { "x-person-id": "TM_BEN" } });
  assert.equal(ben.body.session.clockedIn, false);
} finally {
  earnEngine.stop();
  stopPresence();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

console.log("remote clients ok");
