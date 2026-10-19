/** Sealed phone signal. The mailbox stores ciphertext. Only the shop can open it. */

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

function rawBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** sha256 hex of the bearer token. Matches the hex half of the shop's sha256$ device hash. */
export async function deviceKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(digest);
}

/** Mailbox row id. The same ciphertext from the same token is stored once. */
export async function mailboxId(deviceKeyHex: string, box: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${deviceKeyHex}:${box}`));
  return hex(digest);
}

/** 32 random bytes, base64. Shop .env only. The mailbox never receives this. */
export function generateSealKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToB64(bytes);
}

export function sealKeyBytes(value: string): Uint8Array | null {
  const bytes = b64ToBytes(value.trim());
  if (!bytes || bytes.length !== 32) return null;
  return bytes;
}

async function subkey(master: Uint8Array, label: string): Promise<Uint8Array> {
  const labelBytes = new TextEncoder().encode(label);
  const buf = new Uint8Array(master.length + labelBytes.length);
  buf.set(master, 0);
  buf.set(labelBytes, master.length);
  const digest = await crypto.subtle.digest("SHA-256", rawBuffer(buf));
  return new Uint8Array(digest);
}

/**
 * Per-phone key. HMAC(shop key, "seal:" + token hash).
 * A stolen phone has this value, not the shop key, so it cannot open another phone's box.
 */
export async function deviceSealMaterial(masterB64: string, deviceKeyHex: string): Promise<string> {
  const master = sealKeyBytes(masterB64);
  if (!master) throw new Error("Bad seal key");
  const key = await crypto.subtle.importKey("raw", rawBuffer(master), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`seal:${deviceKeyHex}`));
  return bytesToB64(new Uint8Array(sig));
}

export async function sealRelayBox(
  sealKeyB64: string,
  deviceKeyHex: string,
  payload: RelayPayload,
): Promise<{ box: string; sig: string; envelope: string }> {
  const parsed = parseRelayPayload(payload);
  if (!parsed) throw new Error("Bad relay payload");
  const raw = sealKeyBytes(sealKeyB64);
  if (!raw) throw new Error("Bad seal key");
  const enc = await subkey(raw, "enc");
  const mac = await subkey(raw, "mac");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const aes = await crypto.subtle.importKey("raw", rawBuffer(enc), "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: rawBuffer(iv), additionalData: new TextEncoder().encode(deviceKeyHex) },
    aes,
    new TextEncoder().encode(JSON.stringify(parsed)),
  );
  const ct = new Uint8Array(sealed);
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  const box = bytesToB64(packed);
  const macKey = await crypto.subtle.importKey("raw", rawBuffer(mac), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", macKey, new TextEncoder().encode(`${deviceKeyHex}.${box}`)),
  );
  const sig = bytesToB64(sigBytes);
  return { box, sig, envelope: `v2.${box}.${sig}` };
}

export async function openRelayBox(
  sealKeyB64: string,
  deviceKeyHex: string,
  envelope: string,
): Promise<RelayPayload | null> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== "v2" || !parts[1] || !parts[2]) return null;
  const raw = sealKeyBytes(sealKeyB64);
  if (!raw) return null;
  const mac = await subkey(raw, "mac");
  const sigBytes = b64ToBytes(parts[2]);
  const packed = b64ToBytes(parts[1]);
  if (!sigBytes || !packed || packed.length < 13) return null;
  const macKey = await crypto.subtle.importKey("raw", rawBuffer(mac), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "HMAC",
    macKey,
    rawBuffer(sigBytes),
    new TextEncoder().encode(`${deviceKeyHex}.${parts[1]}`),
  );
  if (!ok) return null;
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  try {
    const enc = await subkey(raw, "enc");
    const aes = await crypto.subtle.importKey("raw", rawBuffer(enc), "AES-GCM", false, ["decrypt"]);
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: rawBuffer(iv), additionalData: new TextEncoder().encode(deviceKeyHex) },
      aes,
      rawBuffer(ct),
    );
    return parseRelayPayload(JSON.parse(new TextDecoder().decode(opened)) as unknown);
  } catch {
    return null;
  }
}
