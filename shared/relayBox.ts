/** Phone signal stored by the mailbox. The shop applies it. The mailbox never stores a raw token. */

export const RELAY_TTL_MS = 72 * 60 * 60 * 1000;

export type RelayPayload = {
  event: "arrive" | "leave" | "tap";
  trigger: "geo" | "wifi" | "nfc";
  ts: number;
  eventId: string;
};

export type ThinHook = {
  kind: string;
  entityId: string;
  teamMemberId: string;
  ts: number;
};

const SECRET = /"(hourly_rate|hourlyCents|hourly|wage|amount|given_name|family_name|access_token|square_access_token)"\s*:/i;

export function mentionsRelayWage(raw: string): boolean {
  return SECRET.test(raw);
}

export function parseRelayPayload(value: unknown): RelayPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (key !== "event" && key !== "trigger" && key !== "ts" && key !== "eventId") return null;
  }
  if (row.event !== "arrive" && row.event !== "leave" && row.event !== "tap") return null;
  if (row.trigger !== "geo" && row.trigger !== "wifi" && row.trigger !== "nfc") return null;
  if (row.event === "tap" && row.trigger !== "nfc") return null;
  if (row.trigger !== "nfc" && row.event === "tap") return null;
  if ((row.trigger === "geo" || row.trigger === "wifi") && row.event === "tap") return null;
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

function clip(value: unknown, max: number): string {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : "";
}

/** sha256 hex of the bearer token. Matches the hex half of the shop's sha256$ device hash. */
export async function deviceKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(digest);
}

/** One row per firing. The same event id from the same token is stored once. */
export async function mailboxId(deviceKeyHex: string, eventId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${deviceKeyHex}:${eventId}`));
  return hex(digest);
}

export async function hookId(kind: string, entityId: string, ts: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${kind}:${entityId}:${ts}`));
  return hex(digest);
}

/**
 * Square webhook reduced to ids and a time.
 * Names, wages, and access tokens are not copied.
 */
export function thinSquareHook(value: unknown, now: number): ThinHook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kind = clip(row.type, 80);
  if (!kind) return null;
  const data = row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : {};
  const object = data.object && typeof data.object === "object" ? (data.object as Record<string, unknown>) : {};
  const timecard = object.timecard && typeof object.timecard === "object" ? (object.timecard as Record<string, unknown>) : {};
  const shift = object.shift && typeof object.shift === "object" ? (object.shift as Record<string, unknown>) : {};
  const entityId = clip(data.id, 80) || clip(timecard.id, 80) || clip(shift.id, 80) || clip(object.id, 80);
  if (!entityId) return null;
  const teamMemberId =
    clip(timecard.team_member_id, 80) || clip(shift.team_member_id, 80) || clip(object.team_member_id, 80);
  let ts = now;
  if (typeof row.created_at === "string") {
    const parsed = Date.parse(row.created_at);
    if (Number.isFinite(parsed) && parsed > 0) ts = parsed;
  }
  return { kind, entityId, teamMemberId, ts };
}
