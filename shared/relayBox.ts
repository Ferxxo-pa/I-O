/** Sealed phone signal. The relay stores the ciphertext. Only the shop can open it. */

export const RELAY_TTL_MS = 72 * 60 * 60 * 1000;

export type RelayPayload = {
  event: "arrive" | "leave";
  trigger: "geo" | "wifi";
  ts: number;
  eventId: string;
};

const WAGE = /"(hourly_rate|hourlyCents|hourly|wage|amount)"\s*:/;

export function mentionsRelayWage(raw: string): boolean {
  return WAGE.test(raw);
}

export function parseRelayPayload(value: unknown): RelayPayload | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (key !== "event" && key !== "trigger" && key !== "ts" && key !== "eventId") return null;
  }
  if (row.event !== "arrive" && row.event !== "leave") return null;
  if (row.trigger !== "geo" && row.trigger !== "wifi") return null;
  if (typeof row.ts !== "number" || !Number.isInteger(row.ts) || row.ts <= 0) return null;
  if (typeof row.eventId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(row.eventId)) return null;
  return { event: row.event, trigger: row.trigger, ts: row.ts, eventId: row.eventId };
}

function hex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(value: string): Uint8Array | null {
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** sha256 hex of the bearer token. Matches the hex half of the shop's sha256$ device hash. */
export async function deviceKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(digest);
}

export async function mailboxId(deviceKeyHex: string, eventId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${deviceKeyHex}:${eventId}`));
  return hex(digest);
}

const RSA = { name: "RSA-OAEP", hash: "SHA-256" } as const;

export async function generateSealPair(): Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicJwk, privateJwk };
}

function publicJwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true };
}

function privateJwk(jwk: JsonWebKey): JsonWebKey {
  return {
    kty: "RSA",
    n: jwk.n,
    e: jwk.e,
    d: jwk.d,
    p: jwk.p,
    q: jwk.q,
    dp: jwk.dp,
    dq: jwk.dq,
    qi: jwk.qi,
    alg: "RSA-OAEP-256",
    ext: true,
  };
}

export async function sealBox(jwk: JsonWebKey, payload: RelayPayload): Promise<string> {
  const parsed = parseRelayPayload(payload);
  if (!parsed) throw new Error("Bad relay payload");
  const key = await crypto.subtle.importKey("jwk", publicJwk(jwk), RSA, false, ["encrypt"]);
  const encoded = new TextEncoder().encode(JSON.stringify(parsed));
  const sealed = await crypto.subtle.encrypt(RSA, key, encoded);
  return bytesToB64(new Uint8Array(sealed));
}

export async function openBox(jwk: JsonWebKey, envelope: string): Promise<RelayPayload | null> {
  const bytes = b64ToBytes(envelope);
  if (!bytes) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", privateJwk(jwk), RSA, false, ["decrypt"]);
    const opened = await crypto.subtle.decrypt(RSA, key, bytes);
    const parsed = JSON.parse(new TextDecoder().decode(opened)) as unknown;
    return parseRelayPayload(parsed);
  } catch {
    return null;
  }
}
