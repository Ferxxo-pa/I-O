import { readiness } from "../../shared/ops.ts";
import { DEFAULT_SHOP } from "../../shared/schema.ts";
import { redactLog } from "../../shared/cloud/audit.ts";
import { corsHeaders, originAllowed } from "../../shared/cloud/cors.ts";
import { iphoneAutomationText, macroFile } from "../../shared/cloud/enroll.ts";
import { hmacSha256Base64, sha256Hex, signaturesMatch } from "../../shared/cloud/hmac.ts";
import { joinMissingHtml, joinPageHtml } from "../../shared/cloud/joinPage.ts";
import { bearerToken, mentionsWage } from "../../shared/cloud/phonePlan.ts";
import { hashPin, pinShape, verifyPbkdf2 } from "../../shared/cloud/pin.ts";
import { importAesKey, keyFromBase64, openSecret, sealSecret } from "../../shared/cloud/secrets.ts";
import { backupDocument, sealBackup } from "../../shared/cloud/backup.ts";
import { cloudState } from "../../shared/cloud/stateView.ts";
import {
  audit,
  companyByCode,
  companyById,
  companyByOwner,
  deviceByHash,
  ledgerCents,
  limited,
  peopleOf,
  personOf,
  punchesOf,
  sessionsOf,
  tokenHash,
  type CompanyRow,
} from "./db.ts";
import type { Env } from "./env.ts";
import { CompanyRoom } from "./room.ts";

export { CompanyRoom };

const SHOP_ADDRESS = "403 E Ben White Blvd, Austin";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const self = url.origin;
    if (origin && !originAllowed(origin, [self])) {
      return respond(request, env, 403, { message: "Origin is not allowed" });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, self) });
    }
    try {
      if (url.pathname.startsWith("/api/") || url.pathname === "/api" || url.pathname.startsWith("/join/")) {
        const response = await route(request, env, url);
        return withCors(request, response);
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.log(redactLog(err instanceof Error ? err.message : "error"));
      return respond(request, env, 500, { message: "Internal Server Error" });
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const at = controller.scheduledTime || Date.now();
    if (controller.cron === "0 8 * * *") {
      await writeBackup(env, at);
      return;
    }
    const companies = await env.DB.prepare("SELECT id FROM companies").all<{ id: string }>();
    for (const row of companies.results ?? []) {
      await callRoom(env, row.id, { op: "reconcile", companyId: row.id, at });
      await callRoom(env, row.id, { op: "autoclose", companyId: row.id, at });
    }
  },
};

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const at = nowOf(request, env);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/health") {
    if (url.searchParams.get("probe") === "1") return respond(request, env, 200, { ok: true });
    const company = await resolveCompany(request, env, false);
    const report = readiness({
      squareToken: Boolean(company?.square_token_enc || env.SQUARE_ACCESS_TOKEN),
      webhookConfigured: Boolean(company?.square_webhook_enc || env.SQUARE_WEBHOOK_SIGNATURE_KEY),
      webhookSeen: Boolean(company?.webhook_seen_at),
      pinSet: Boolean(company?.pin_hash),
      rentEntered: false,
      ratesOk: true,
      rateDetail: "Square keeps the rates",
      ownLoginPct: null,
      ownLoginDetail: "Hosted",
      backupOk: false,
      publicUrlOk: true,
      publicUrlDetail: url.origin,
      publicUrlNote: url.host,
    });
    return respond(request, env, 200, { ok: true, ...report, scope: { companyId: company?.id ?? "", locationId: company?.location_id ?? "local" } });
  }

  if (request.method === "POST" && path === "/api/company") return createCompany(request, env, at);
  if (request.method === "POST" && path === "/api/company/join") return join(request, env, at);
  if (request.method === "GET" && path === "/api/company") return readCompany(request, env);
  if (request.method === "POST" && path === "/api/company/square") return saveSquare(request, env, at);
  if (request.method === "POST" && path === "/api/company/people") return addPerson(request, env, at);
  if (request.method === "GET" && path === "/api/company/who") return who(request, env);
  if (request.method === "GET" && path === "/api/company/roster") return roster(request, env);
  if (request.method === "POST" && path === "/api/fight/pin") return setPin(request, env, at);
  if (request.method === "PATCH" && (path === "/api/fight/settings" || path === "/api/fight/levels")) return saveFight(request, env, at);
  if (request.method === "GET" && path === "/api/state") return state(request, env, at);
  if (request.method === "GET" && path === "/api/presence") return state(request, env, at, true);
  if (request.method === "POST" && path === "/api/clock/in") return clock(request, env, at, "in");
  if (request.method === "POST" && path === "/api/clock/out") return clock(request, env, at, "out");
  if (request.method === "POST" && path === "/api/presence/consent") return consent(request, env, at);
  if (request.method === "POST" && path === "/api/presence/phone/setup") return setupPhone(request, env, at, url);
  if (request.method === "POST" && path === "/api/presence/phone/ping") return ping(request, env);
  if (request.method === "POST" && path === "/api/presence/phone") return phone(request, env, at);
  if (request.method === "POST" && path.startsWith("/api/square/webhook/")) {
    return webhook(request, env, at, decodeURIComponent(path.slice("/api/square/webhook/".length)));
  }
  if (request.method === "GET" && path.startsWith("/join/")) return joinPage(request, env, path.slice("/join/".length).replace(/\/open$/, ""), url);
  if (request.method === "POST" && /^\/join\/[^/]+\/open$/.test(path)) {
    return openJoin(request, env, at, path.split("/")[2]);
  }
  if (request.method === "GET" && path === "/api/test/square" && env.IO_TEST === "1") return squareLog(request, env);
  if (request.method === "GET" && path === "/api/test/audit" && env.IO_TEST === "1") return auditLog(request, env);

  return respond(request, env, 404, { message: "Not found" });
}

async function createCompany(request: Request, env: Env, at: number): Promise<Response> {
  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return respond(request, env, 400, { message: "Name the company" });
  const id = crypto.randomUUID();
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const ownerKey = bytesToUrl(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare(
    `INSERT INTO companies (id, name, code, location_id, owner_key_hash, shop_json, created_at)
     VALUES (?1, ?2, ?3, 'local', ?4, ?5, ?6)`,
  )
    .bind(id, name, code, sha256Hex(ownerKey), JSON.stringify(DEFAULT_SHOP), at)
    .run();
  await audit(env.DB, { companyId: id, at, action: "company_create", actor: "owner", ok: true });
  const view = await companyView(env, (await companyById(env.DB, id))!, ownerKey);
  return respond(request, env, 200, { ...view, ownerKey }, companyCookie(id, request));
}

async function join(request: Request, env: Env, at: number): Promise<Response> {
  const body = await readJson(request);
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  const company = code ? await companyByCode(env.DB, code) : null;
  if (!company) return respond(request, env, 400, { message: "No company with that code" });
  await audit(env.DB, { companyId: company.id, at, action: "company_join", actor: "anon", ok: true });
  const owner = await presentedOwner(request, company);
  return respond(request, env, 200, await companyView(env, company, owner ? "owner" : null), companyCookie(company.id, request));
}

async function readCompany(request: Request, env: Env): Promise<Response> {
  const company = await resolveCompany(request, env, false);
  if (!company) {
    return respond(request, env, 200, { name: null, code: null, id: null, locationId: null, shop: DEFAULT_SHOP, people: [], owner: false, square: false });
  }
  const owner = await presentedOwner(request, company);
  return respond(request, env, 200, await companyView(env, company, owner ? "owner" : null));
}

async function saveSquare(request: Request, env: Env, at: number): Promise<Response> {
  const company = await requireOwner(request, env);
  if (company instanceof Response) return company;
  const body = await readJson(request);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const webhookKey = typeof body.webhookKey === "string" ? body.webhookKey.trim() : "";
  if (!token || !env.TOKEN_KEY) return respond(request, env, 400, { message: "Square token is missing" });
  const key = await importAesKey(keyFromBase64(env.TOKEN_KEY));
  const tokenEnc = await sealSecret(key, token);
  const hookEnc = webhookKey ? await sealSecret(key, webhookKey) : null;
  const hookUrl = `${new URL(request.url).origin}/api/square/webhook/${company.id}`;
  await env.DB.prepare(
    "UPDATE companies SET square_token_enc = ?1, square_webhook_enc = ?2, webhook_url = ?3, location_id = COALESCE(NULLIF(?4, ''), location_id) WHERE id = ?5",
  )
    .bind(tokenEnc, hookEnc, hookUrl, typeof body.locationId === "string" ? body.locationId.trim() : "", company.id)
    .run();
  await audit(env.DB, { companyId: company.id, at, action: "square_seal", actor: "owner", ok: true });
  console.log(redactLog("sealed square token"));
  return respond(request, env, 200, { ok: true, webhookUrl: hookUrl });
}

async function addPerson(request: Request, env: Env, at: number): Promise<Response> {
  const company = await requireOwner(request, env);
  if (company instanceof Response) return company;
  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const hourly = Number(body.hourlyCents);
  if (!name || !Number.isInteger(hourly) || hourly <= 0) return respond(request, env, 400, { message: "Name the person" });
  const squareId = typeof body.squareTeamMemberId === "string" ? body.squareTeamMemberId.trim() : "";
  const id = squareId || crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO people (
      company_id, id, name, points, made_cents, hourly_cents, status, square_team_member_id, square_location_id
    ) VALUES (?1, ?2, ?3, 0, 0, ?4, 'active', ?5, ?6)`,
  )
    .bind(company.id, id, name, hourly, squareId || null, company.location_id)
    .run();
  await audit(env.DB, { companyId: company.id, at, action: "person_add", actor: "owner", ok: true });
  return respond(request, env, 200, await companyView(env, company, "owner"));
}

async function who(request: Request, env: Env): Promise<Response> {
  const company = await requireReader(request, env);
  if (company instanceof Response) return company;
  const people = await peopleOf(env.DB, company.id);
  return respond(request, env, 200, {
    source: company.square_token_enc ? "square" : "manual",
    people: people.map((person) => ({ id: person.id, name: person.name })),
  });
}

async function roster(request: Request, env: Env): Promise<Response> {
  const company = await requireOwner(request, env);
  if (company instanceof Response) return company;
  const people = await peopleOf(env.DB, company.id);
  return respond(request, env, 200, {
    source: company.square_token_enc ? "square" : "manual",
    people: people.map((person) => ({
      id: person.id,
      name: person.name,
      hourlyCents: person.hourly_cents,
      squareTeamMemberId: person.square_team_member_id,
    })),
  });
}

async function setPin(request: Request, env: Env, at: number): Promise<Response> {
  const company = await resolveCompany(request, env, true);
  if (!company) return respond(request, env, 401, { message: "Unknown company" });
  const body = await readJson(request);
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  if (!pinShape(pin)) return respond(request, env, 400, { message: "PIN is 4 to 8 digits" });
  if (company.pin_hash) {
    const reader = await requireReader(request, env);
    if (reader instanceof Response) return reader;
  } else if (!(await presentedOwner(request, company))) {
    return respond(request, env, 403, { message: "Only the owner can change that" });
  }
  const hash = await hashPin(pin);
  await env.DB.prepare("UPDATE companies SET pin_hash = ?1 WHERE id = ?2").bind(hash, company.id).run();
  await audit(env.DB, { companyId: company.id, at, action: "pin_set", actor: "owner", ok: true });
  return respond(request, env, 200, { ok: true, pinSet: true }, readerCookie(env, company.id, at, request));
}

async function saveFight(request: Request, env: Env, at: number): Promise<Response> {
  const company = await requirePin(request, env, at);
  if (company instanceof Response) return company;
  const body = await readJson(request);
  await env.DB.prepare("UPDATE companies SET fight_json = ?1 WHERE id = ?2").bind(JSON.stringify(body), company.id).run();
  await audit(env.DB, { companyId: company.id, at, action: "fight_save", actor: "pin", ok: true });
  return respond(request, env, 200, await buildState(env, company, request.headers.get("x-person-id"), at));
}

async function state(request: Request, env: Env, at: number, presenceOnly = false): Promise<Response> {
  const company = await requireReader(request, env);
  if (company instanceof Response) return company;
  const viewer = request.headers.get("x-person-id");
  const snapshot = await buildState(env, company, viewer, at);
  const extra = readerCookie(env, company.id, at, request);
  return respond(request, env, 200, presenceOnly ? snapshot.presence : snapshot, extra);
}

async function clock(request: Request, env: Env, at: number, dir: "in" | "out"): Promise<Response> {
  const company = await requirePin(request, env, at);
  if (company instanceof Response) return company;
  if (await limited(env.DB, `clock:${clientIp(request)}`, 30, at)) return respond(request, env, 429, { message: "Too many tries" });
  const body = await readJson(request);
  const headerId = request.headers.get("x-person-id")?.trim() ?? "";
  const bodyId = typeof body.personId === "string" ? body.personId.trim() : "";
  if (bodyId && headerId && bodyId !== headerId) return respond(request, env, 403, { message: "This computer is linked to someone else" });
  const personId = bodyId || headerId;
  if (!personId) return respond(request, env, 400, { message: "Choose who you are" });
  const person = await personOf(env.DB, company.id, personId);
  if (!person) return respond(request, env, 400, { message: "That person is not on this business" });
  const result = await callRoom(env, company.id, {
    op: dir === "in" ? "clock-in" : "clock-out",
    companyId: company.id,
    personId,
    at,
    source: "manual",
  });
  if (!result.ok) return respond(request, env, 400, { message: result.message ?? "Clock failed" });
  return respond(request, env, 200, await buildState(env, company, personId, at));
}

async function consent(request: Request, env: Env, at: number): Promise<Response> {
  const company = await requireOwner(request, env);
  if (company instanceof Response) return company;
  const body = await readJson(request);
  const personId = typeof body.personId === "string" ? body.personId.trim() : "";
  const person = await personOf(env.DB, company.id, personId);
  if (!person) return respond(request, env, 400, { message: "That person is not on this business" });
  const yes = body.consent !== false;
  await env.DB.prepare(
    "UPDATE people SET consented_at = ?1, consent_revoked_at = ?2, consent_note = ?3 WHERE company_id = ?4 AND id = ?5",
  )
    .bind(yes ? at : person.consented_at, yes ? null : at, yes && typeof body.note === "string" ? body.note.slice(0, 200) : person.consent_note, company.id, personId)
    .run();
  await audit(env.DB, { companyId: company.id, at, action: yes ? "consent_yes" : "consent_no", actor: "owner", ok: true });
  return respond(request, env, 200, { ok: true });
}

async function setupPhone(request: Request, env: Env, at: number, url: URL): Promise<Response> {
  const company = await requireOwner(request, env);
  if (company instanceof Response) return company;
  const body = await readJson(request);
  const personId = typeof body.personId === "string" ? body.personId.trim() : "";
  const person = await personOf(env.DB, company.id, personId);
  if (!person) return respond(request, env, 400, { message: "That person is not on this business" });
  const token = bytesToUrl(crypto.getRandomValues(new Uint8Array(24)));
  const deviceId = crypto.randomUUID();
  const code = bytesToUrl(crypto.getRandomValues(new Uint8Array(18)));
  const phoneUrl = `${url.origin}/api/presence/phone`;
  const key = await importAesKey(keyFromBase64(env.TOKEN_KEY));
  await env.DB.prepare(
    `INSERT INTO devices (company_id, id, person_id, token_hash, square_team_member_id)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(company.id, deviceId, person.id, tokenHash(token), person.square_team_member_id ?? "")
    .run();
  await env.DB.prepare(
    `INSERT INTO invites (code, company_id, person_id, name, device_id, token_enc, phone_url)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(code, company.id, person.id, person.name, deviceId, await sealSecret(key, token), phoneUrl)
    .run();
  await audit(env.DB, { companyId: company.id, at, action: "phone_setup", actor: "owner", ok: true });
  return respond(request, env, 200, {
    personId: person.id,
    name: person.name,
    deviceId,
    inviteUrl: `${url.origin}/join/${code}`,
    squareTeamMemberId: person.square_team_member_id ?? "",
    squareLocationId: person.square_location_id ?? company.location_id,
  });
}

async function ping(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return respond(request, env, 401, { ok: false, connected: false, message: "Unknown device" });
  const device = await deviceByHash(env.DB, tokenHash(token));
  if (!device) return respond(request, env, 401, { ok: false, connected: false, message: "Unknown device" });
  const person = await personOf(env.DB, device.company_id, device.person_id);
  if (!person || person.consented_at == null || person.consent_revoked_at != null) {
    return respond(request, env, 403, { ok: false, connected: false, message: "No consent" });
  }
  return respond(request, env, 200, { ok: true, connected: true, name: person.name });
}

async function phone(request: Request, env: Env, at: number): Promise<Response> {
  const raw = await request.text();
  if (mentionsWage(raw)) return respond(request, env, 400, { message: "Presence never writes a wage" });
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return respond(request, env, 401, { message: "Unknown device" });
  if (await limited(env.DB, `phone:${clientIp(request)}`, 60, at)) return respond(request, env, 429, { message: "Too many signals" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return respond(request, env, 400, { message: "Check the signal" });
  }
  const signal = body as { event?: string; trigger?: string; ts?: number; eventId?: string };
  if ((signal.event !== "arrive" && signal.event !== "leave") || (signal.trigger !== "geo" && signal.trigger !== "wifi")) {
    return respond(request, env, 400, { message: "Check the signal" });
  }
  const device = await deviceByHash(env.DB, tokenHash(token));
  if (!device) return respond(request, env, 401, { message: "Unknown device" });
  const headerCompany = request.headers.get("x-company-id")?.trim();
  if (headerCompany && headerCompany !== device.company_id) return respond(request, env, 403, { message: "Unknown device" });
  const result = await callRoom(env, device.company_id, {
    op: "phone",
    companyId: device.company_id,
    deviceId: device.id,
    personId: device.person_id,
    signal,
    at,
  });
  const status = typeof result.status === "number" ? result.status : 200;
  return respond(request, env, status, result.body ?? result);
}

async function webhook(request: Request, env: Env, at: number, companyId: string): Promise<Response> {
  const company = await companyById(env.DB, companyId);
  if (!company) return respond(request, env, 401, { message: "Square webhook is not configured" });
  const raw = await request.text();
  const key = await webhookKey(env, company);
  const url = company.webhook_url || env.SQUARE_WEBHOOK_NOTIFICATION_URL || "";
  if (!key || !url) return respond(request, env, 401, { message: "Square webhook is not configured" });
  const header = request.headers.get("x-square-hmacsha256-signature") ?? "";
  const expected = hmacSha256Base64(key, url + raw);
  if (!signaturesMatch(header, expected)) return respond(request, env, 403, { message: "Invalid Square signature" });
  let payload: unknown = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  const result = await callRoom(env, company.id, { op: "webhook", companyId: company.id, payload, at });
  return respond(request, env, 200, result);
}

async function joinPage(request: Request, env: Env, code: string, url: URL): Promise<Response> {
  const row = await env.DB.prepare("SELECT name, opened_at, company_id FROM invites WHERE code = ?1").bind(code).first<{
    name: string;
    opened_at: number | null;
    company_id: string;
  }>();
  if (!row) return html(joinMissingHtml(), 404);
  const company = await companyById(env.DB, row.company_id);
  const shop = company ? (JSON.parse(company.shop_json) as { wifiSsid?: string }) : {};
  const page = joinPageHtml({
    name: row.name,
    ssid: shop.wifiSsid?.trim() || "Premiere",
    address: SHOP_ADDRESS,
    inviteUrl: `${url.origin}/join/${code}`,
    opened: row.opened_at != null,
  });
  return html(page, 200);
}

async function openJoin(request: Request, env: Env, at: number, code: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM invites WHERE code = ?1").bind(code).first<{
    company_id: string;
    person_id: string;
    name: string;
    token_enc: string;
    phone_url: string;
    opened_at: number | null;
  }>();
  if (!row) return respond(request, env, 404, { message: "This link is not valid" });
  if (row.opened_at != null) return respond(request, env, 410, { message: "This link was already used" });
  const key = await importAesKey(keyFromBase64(env.TOKEN_KEY));
  const token = await openSecret(key, row.token_enc);
  await env.DB.prepare("UPDATE invites SET opened_at = ?1 WHERE code = ?2").bind(at, code).run();
  const company = await companyById(env.DB, row.company_id);
  const shop = company ? (JSON.parse(company.shop_json) as { wifiSsid?: string; fenceLat?: number; fenceLng?: number; fenceRadiusM?: number }) : {};
  const fields = {
    url: row.phone_url,
    token,
    ssid: shop.wifiSsid?.trim() || "Premiere",
    address: SHOP_ADDRESS,
    lat: shop.fenceLat ?? 30.219778,
    lng: shop.fenceLng ?? -97.760707,
    radius: shop.fenceRadiusM ?? 120,
  };
  return respond(request, env, 200, {
    ...fields,
    name: row.name,
    iphone: iphoneAutomationText(fields),
    macro: macroFile(fields),
  });
}

async function squareLog(request: Request, env: Env): Promise<Response> {
  const company = await resolveCompany(request, env, true);
  if (!company) return respond(request, env, 404, { message: "Unknown company" });
  const rows = await env.DB.prepare("SELECT method, path FROM square_log WHERE company_id = ?1 ORDER BY id").bind(company.id).all<{ method: string; path: string }>();
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM square_cards WHERE company_id = ?1 AND open = 1").bind(company.id).first<{ n: number }>();
  return respond(request, env, 200, { calls: rows.results ?? [], open: open?.n ?? 0 });
}

async function auditLog(request: Request, env: Env): Promise<Response> {
  const company = await resolveCompany(request, env, true);
  if (!company) return respond(request, env, 404, { message: "Unknown company" });
  const rows = await env.DB.prepare("SELECT action, actor, ok FROM audit WHERE company_id = ?1").bind(company.id).all();
  return respond(request, env, 200, { rows: rows.results ?? [] });
}

async function buildState(env: Env, company: CompanyRow, viewerId: string | null, at: number) {
  const [people, shifts, punches, collected] = await Promise.all([
    peopleOf(env.DB, company.id),
    sessionsOf(env.DB, company.id),
    punchesOf(env.DB, company.id),
    ledgerCents(env.DB, company.id),
  ]);
  return cloudState({
    now: at,
    companyId: company.id,
    locationId: company.location_id,
    viewerId,
    shifts,
    collectedCents: collected,
    pinSet: Boolean(company.pin_hash),
    people: people.map((person) => ({ id: person.id, name: person.name })),
    punches,
    squareConnected: Boolean(company.square_token_enc || env.SQUARE_ACCESS_TOKEN),
  });
}

async function companyView(env: Env, company: CompanyRow, ownerMark: string | null) {
  const people = await peopleOf(env.DB, company.id);
  return {
    name: company.name,
    code: company.code,
    id: company.id,
    locationId: company.location_id,
    shop: { ...DEFAULT_SHOP, ...JSON.parse(company.shop_json) },
    people: people.map((person) => ({
      id: person.id,
      name: person.name,
      points: person.points,
      madeCents: person.made_cents,
      hourlyCents: person.hourly_cents,
      status: person.status,
      consentedAt: person.consented_at,
      consentRevokedAt: person.consent_revoked_at,
      consentNote: person.consent_note,
      squareTeamMemberId: person.square_team_member_id,
      squareLocationId: person.square_location_id,
    })),
    owner: Boolean(ownerMark),
    square: Boolean(company.square_token_enc || env.SQUARE_ACCESS_TOKEN),
    ...(ownerMark && ownerMark !== "owner" ? { ownerKey: ownerMark } : {}),
  };
}

async function resolveCompany(request: Request, env: Env, required: boolean): Promise<CompanyRow | null> {
  const header = request.headers.get("x-company-id")?.trim();
  const cookie = readCookie(request, "io_company");
  const id = header || cookie;
  if (id) {
    const row = await companyById(env.DB, id);
    if (row) return row;
  }
  const owner = request.headers.get("x-owner-key")?.trim();
  if (owner) {
    const row = await companyByOwner(env.DB, sha256Hex(owner));
    if (row) return row;
  }
  if (required) return null;
  return null;
}

async function presentedOwner(request: Request, company: CompanyRow): Promise<boolean> {
  const owner = request.headers.get("x-owner-key")?.trim() ?? "";
  if (!owner || !company.owner_key_hash) return false;
  return signaturesMatch(sha256Hex(owner), company.owner_key_hash);
}

async function requireOwner(request: Request, env: Env): Promise<CompanyRow | Response> {
  const company = await resolveCompany(request, env, true);
  if (!company) return respond(request, env, 401, { message: "Unknown company" });
  if (!(await presentedOwner(request, company))) return respond(request, env, 403, { message: "Only the owner can change that" });
  return company;
}

async function requireReader(request: Request, env: Env): Promise<CompanyRow | Response> {
  const company = await resolveCompany(request, env, true);
  if (!company) return respond(request, env, 401, { message: "Unknown company" });
  if (await presentedOwner(request, company)) return company;
  if (sessionOk(request, env, company.id)) return company;
  return requirePin(request, env, nowOf(request, env));
}

async function requirePin(request: Request, env: Env, at: number): Promise<CompanyRow | Response> {
  const company = await resolveCompany(request, env, true);
  if (!company) return respond(request, env, 401, { message: "Unknown company" });
  if (!company.pin_hash) return respond(request, env, 403, { message: "Set a shop PIN in Settings" });
  const pin = request.headers.get("x-shop-pin")?.trim() ?? "";
  if (!(await verifyPbkdf2(pin, company.pin_hash))) {
    await audit(env.DB, { companyId: company.id, at, action: "pin_fail", actor: "anon", ok: false });
    return respond(request, env, 401, { message: "Wrong PIN" });
  }
  return company;
}

function sessionOk(request: Request, env: Env, companyId: string): boolean {
  const token = readCookie(request, "io_reader");
  if (!token || !env.TOKEN_KEY) return false;
  const [id, exp, sig] = token.split(".");
  if (!id || !exp || !sig) return false;
  if (id !== companyId) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = hmacSha256Base64(env.TOKEN_KEY, `${id}.${exp}`);
  return signaturesMatch(sig, expected);
}

function readerCookie(env: Env, companyId: string, at: number, request: Request): string {
  const exp = at + 12 * 60 * 60 * 1000;
  const sig = hmacSha256Base64(env.TOKEN_KEY, `${companyId}.${exp}`);
  return cookie("io_reader", `${companyId}.${exp}.${sig}`, request);
}

function companyCookie(id: string, request: Request): string {
  return cookie("io_company", id, request, 365 * 24 * 60 * 60);
}

function cookie(name: string, value: string, request: Request, maxAge = 12 * 60 * 60): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function webhookKey(env: Env, company: CompanyRow): Promise<string> {
  if (company.square_webhook_enc && env.TOKEN_KEY) {
    const key = await importAesKey(keyFromBase64(env.TOKEN_KEY));
    return openSecret(key, company.square_webhook_enc);
  }
  return env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim() ?? "";
}

async function callRoom(env: Env, companyId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stub = env.COMPANY.get(env.COMPANY.idFromName(companyId));
  const res = await stub.fetch("https://company.internal/", { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
}

async function writeBackup(env: Env, at: number): Promise<void> {
  if (!env.BACKUP_KEY) return;
  const tables = ["companies", "people", "devices", "punches", "sessions", "ledger", "seen", "watches", "invites", "audit", "backups"];
  const dumped = [];
  for (const name of tables) {
    const rows = await env.DB.prepare(`SELECT * FROM ${name}`).all();
    dumped.push({ name, rows: rows.results ?? [] });
  }
  const document = backupDocument(dumped, at);
  const key = await importAesKey(keyFromBase64(env.BACKUP_KEY));
  const bytes = await sealBackup(key, document);
  const r2Key = `backups/${new Date(at).toISOString().slice(0, 10)}.json.enc`;
  await env.BACKUPS.put(r2Key, bytes);
  await env.DB.prepare("INSERT OR REPLACE INTO backups (id, at, r2_key) VALUES (?1, ?2, ?3)").bind(r2Key, at, r2Key).run();
  await audit(env.DB, { companyId: null, at, action: "backup", actor: "cron", ok: true });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.includes("application/json") === false && !request.body) return {};
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function nowOf(request: Request, env: Env): number {
  if (env.IO_TEST === "1") {
    const raw = request.headers.get("x-io-now");
    if (raw && Number.isFinite(Number(raw))) return Number(raw);
  }
  return Date.now();
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function bytesToUrl(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function respond(request: Request, env: Env, status: number, body: unknown, setCookie?: string): Response {
  void env;
  const headers = corsHeaders(request.headers.get("origin"), new URL(request.url).origin);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  if (setCookie) headers.append("set-cookie", setCookie);
  if (status >= 500) console.log(redactLog(`error ${status}`));
  return new Response(JSON.stringify(body), { status, headers });
}

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const extra = corsHeaders(request.headers.get("origin"), new URL(request.url).origin);
  extra.forEach((value, key) => {
    if (!headers.has(key)) headers.set(key, value);
  });
  return new Response(response.body, { status: response.status, headers });
}

function html(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
