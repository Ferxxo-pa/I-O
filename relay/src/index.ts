import { RELAY_TTL_MS, deviceKey, hookId, mailboxId, mentionsRelayWage, parseRelayPayload, thinSquareHook } from "../../shared/relayBox.ts";

const DROP_PER_MIN = 30;
const SHOP_PER_MIN = 120;

export type RelayDb = {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
};

export type RelayEnv = {
  DB: RelayDb;
  RELAY_SHOP_SECRET?: string;
  RELAY_SQUARE_WEBHOOK_KEY?: string;
  RELAY_SQUARE_NOTIFICATION_URL?: string;
};

type BoxRow = {
  id: string;
  device_key: string;
  event: string;
  trigger: string;
  ts: number;
  event_id: string;
  received_at: number;
};

type HookRow = {
  id: string;
  kind: string;
  entity_id: string;
  team_member_id: string;
  ts: number;
  received_at: number;
};

const hits = new Map<string, number[]>();

export function resetRelayLimits() {
  hits.clear();
}

function limited(key: string, limit: number, now: number): boolean {
  const prev = (hits.get(key) ?? []).filter((ts) => now - ts < 60_000);
  if (prev.length >= limit) {
    hits.set(key, prev);
    return true;
  }
  prev.push(now);
  hits.set(key, prev);
  return false;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? "";
}

function shopAuthorized(request: Request, env: RelayEnv): boolean {
  const token = bearer(request);
  const secret = env.RELAY_SHOP_SECRET ?? "";
  if (!token || !secret || token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function sameText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function squareSignature(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return bytesToB64(new Uint8Array(signed));
}

async function drop(request: Request, env: RelayEnv, now: number): Promise<Response> {
  if (limited(`drop:${clientIp(request)}`, DROP_PER_MIN, now)) return json(429, { ok: false });
  const token = bearer(request);
  if (!token) return json(401, { ok: false });
  const raw = await request.text();
  if (raw.length > 4096 || mentionsRelayWage(raw)) return json(400, { ok: false });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return json(400, { ok: false });
  }
  const payload = parseRelayPayload(parsed);
  if (!payload) return json(400, { ok: false });
  const key = await deviceKey(token);
  const id = await mailboxId(key, payload.eventId);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO boxes (id, device_key, event, trigger, ts, event_id, received_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(id, key, payload.event, payload.trigger, payload.ts, payload.eventId, now, now + RELAY_TTL_MS)
    .run();
  return json(200, { ok: true });
}

async function square(request: Request, env: RelayEnv, now: number): Promise<Response> {
  const key = env.RELAY_SQUARE_WEBHOOK_KEY?.trim() ?? "";
  const notificationUrl = env.RELAY_SQUARE_NOTIFICATION_URL?.trim() ?? "";
  if (!key || !notificationUrl) return json(404, { ok: false });
  const raw = await request.text();
  if (raw.length > 65536) return json(400, { ok: false });
  const header = request.headers.get("x-square-hmacsha256-signature") ?? "";
  const expected = await squareSignature(key, notificationUrl + raw);
  if (!sameText(header, expected)) return json(401, { ok: false });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return json(400, { ok: false });
  }
  const hook = thinSquareHook(parsed, now);
  if (!hook) return json(400, { ok: false });
  const id = await hookId(hook.kind, hook.entityId, hook.ts);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO hooks (id, kind, entity_id, team_member_id, ts, received_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, hook.kind, hook.entityId, hook.teamMemberId, hook.ts, now, now + RELAY_TTL_MS)
    .run();
  return json(200, { ok: true });
}

async function pull(request: Request, env: RelayEnv, now: number): Promise<Response> {
  if (!shopAuthorized(request, env)) return json(401, { ok: false });
  if (limited("shop:pull", SHOP_PER_MIN, now)) return json(429, { ok: false });
  await env.DB.prepare("DELETE FROM boxes WHERE expires_at <= ?1").bind(now).run();
  await env.DB.prepare("DELETE FROM hooks WHERE expires_at <= ?1").bind(now).run();
  const selected = await env.DB.prepare(
    "SELECT id, device_key, event, trigger, ts, event_id, received_at FROM boxes WHERE expires_at > ?1 ORDER BY received_at ASC LIMIT 50",
  )
    .bind(now)
    .all<BoxRow>();
  const hookRows = await env.DB.prepare(
    "SELECT id, kind, entity_id, team_member_id, ts, received_at FROM hooks WHERE expires_at > ?1 ORDER BY received_at ASC LIMIT 50",
  )
    .bind(now)
    .all<HookRow>();
  const messages = (selected.results ?? []).map((row) => ({
    id: row.id,
    deviceKey: row.device_key,
    event: row.event,
    trigger: row.trigger,
    ts: row.ts,
    eventId: row.event_id,
    receivedAt: row.received_at,
  }));
  const hooks = (hookRows.results ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    entityId: row.entity_id,
    teamMemberId: row.team_member_id,
    ts: row.ts,
    receivedAt: row.received_at,
  }));
  return json(200, { messages, hooks });
}

async function ack(request: Request, env: RelayEnv, now: number): Promise<Response> {
  if (!shopAuthorized(request, env)) return json(401, { ok: false });
  if (limited("shop:ack", SHOP_PER_MIN, now)) return json(429, { ok: false });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false });
  }
  const ids = (body as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.length > 100) return json(400, { ok: false });
  for (const id of ids) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) continue;
    await env.DB.prepare("DELETE FROM boxes WHERE id = ?1").bind(id).run();
    await env.DB.prepare("DELETE FROM hooks WHERE id = ?1").bind(id).run();
  }
  return json(200, { ok: true });
}

export async function handleRelay(request: Request, env: RelayEnv, now = Date.now()): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/drop") return drop(request, env, now);
  if (request.method === "POST" && path === "/square") return square(request, env, now);
  if (request.method === "GET" && path === "/pull") return pull(request, env, now);
  if (request.method === "POST" && path === "/ack") return ack(request, env, now);
  return new Response("Not found", { status: 404 });
}

export default {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRelay(request, env);
  },
};
