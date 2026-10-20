import type { PunchType } from "@shared/presence";

export type ParsedPunch = {
  type: PunchType;
  lat: number;
  lng: number;
  accuracy: number;
  capturedAt: number;
  source: string;
  claimedPersonId: string | null;
};

const SOURCE = /^[a-z0-9_-]{1,32}$/;

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sourceOf(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const slug = value.trim().toLowerCase();
  return SOURCE.test(slug) ? slug : fallback;
}

function typeOf(value: unknown): PunchType | null {
  if (value === "arrive" || value === "in") return "arrive";
  if (value === "leave" || value === "out") return "leave";
  return null;
}

/**
 * Accepts this server's arrive/leave body and Iban's in/out fix body.
 * Identity is not read here. The PIN is resolved separately and never stored.
 */
export function parsePunchBody(
  body: unknown,
  claimedFromHeader: string | null,
  sourceFallback = "phone",
): ParsedPunch | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const fix = raw.fix && typeof raw.fix === "object" ? (raw.fix as Record<string, unknown>) : null;
  const type = typeOf(raw.type) ?? typeOf(raw.action);
  const lat = asNumber(raw.lat) ?? (fix ? asNumber(fix.lat) : null);
  const lng = asNumber(raw.lng) ?? (fix ? asNumber(fix.lng) : null);
  const accuracy = asNumber(raw.accuracy) ?? asNumber(raw.accuracyM) ?? (fix ? asNumber(fix.accuracyM) ?? asNumber(fix.accuracy) : null);
  const capturedAt = asNumber(raw.capturedAt) ?? (fix ? asNumber(fix.capturedAt) : null) ?? asNumber(raw.ts);
  if (!type || lat == null || lng == null || accuracy == null || capturedAt == null) return null;
  const claimed =
    (typeof raw.personId === "string" && raw.personId.trim()) ||
    (typeof raw.person === "string" && raw.person.trim()) ||
    claimedFromHeader ||
    null;
  return {
    type,
    lat,
    lng,
    accuracy,
    capturedAt,
    source: sourceOf(raw.source, sourceFallback),
    claimedPersonId: claimed,
  };
}
