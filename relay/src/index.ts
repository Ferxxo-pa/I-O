import { RELAY_TTL_MS, deviceKey, mailboxId, mentionsRelayWage, parseRelayPayload, sealBox } from "../../shared/relayBox.ts";

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
  RELAY_SEAL_PUBLIC_JWK?: string;
};

type BoxRow = {
  id: string;
  device_key: string;
  envelope: string;
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

async function drop(request: Request, env: RelayEnv, now: number): Promise<Response> {
  if (limited(`drop:${clientIp(request)}`, DROP_PER_MIN, now)) return json(429, { ok: false });
  const token = bearer(request);
  if (!token) return json(401, { ok: false });
  const raw = await request.text();
  if (raw.length > 1024 || mentionsRelayWage(raw)) return json(400, { ok: false });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return json(400, { ok: false });
  }
  const payload = parseRelayPayload(parsed);
  if (!payload) return json(400, { ok: false });
  const rawKey = env.RELAY_SEAL_PUBLIC_JWK?.trim() ?? "";
  if (!rawKey) return json(503, { ok: false });
  let publicJwk: JsonWebKey;
  try {
    publicJwk = JSON.parse(rawKey) as JsonWebKey;
  } catch {
    return json(503, { ok: false });
  }
  const key = await deviceKey(token);
  const envelope = await sealBox(publicJwk, payload);
  const id = await mailboxId(key, payload.eventId);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO boxes (id, device_key, envelope, received_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, key, envelope, now, now + RELAY_TTL_MS)
    .run();
  return json(200, { ok: true });
}

async function pull(request: Request, env: RelayEnv, now: number): Promise<Response> {
  if (!shopAuthorized(request, env)) return json(401, { ok: false });
  if (limited("shop:pull", SHOP_PER_MIN, now)) return json(429, { ok: false });
  await env.DB.prepare("DELETE FROM boxes WHERE expires_at <= ?1").bind(now).run();
  const selected = await env.DB.prepare(
    "SELECT id, device_key, envelope, received_at FROM boxes WHERE expires_at > ?1 ORDER BY received_at ASC LIMIT 50",
  )
    .bind(now)
    .all<BoxRow>();
  const messages = (selected.results ?? []).map((row) => ({
    id: row.id,
    deviceKey: row.device_key,
    envelope: row.envelope,
    receivedAt: row.received_at,
  }));
  return json(200, { messages });
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
  }
  return json(200, { ok: true });
}

export async function handleRelay(request: Request, env: RelayEnv, now = Date.now()): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/drop") return drop(request, env, now);
  if (request.method === "GET" && path === "/pull") return pull(request, env, now);
  if (request.method === "POST" && path === "/ack") return ack(request, env, now);
  return new Response("Not found", { status: 404 });
}

export default {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRelay(request, env);
  },
};
