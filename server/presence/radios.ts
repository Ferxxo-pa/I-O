import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { blankSession, type SessionState } from "./session";

export const RADIO_KINDS = ["phone", "pc", "printer", "other"] as const;
export type RadioKind = (typeof RADIO_KINDS)[number];

export type RadioRow = SessionState & {
  id: string;
  deviceHash: string;
  kind: RadioKind;
  personId: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
};

export function deviceHashPepper(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.PRESENCE_DEVICE_HASH_PEPPER?.trim() ?? "";
  if (set) return set;
  if (env.NODE_ENV === "production") return "";
  return "dev-presence-device-pepper";
}

/** MAC-like ids collapse to aa:bb:cc:dd:ee:ff. Other controller ids stay lowercase. */
export function normalizeDeviceId(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 128) return null;
  const hex = trimmed.replace(/[^a-f0-9]/g, "");
  const separatorsOnly = trimmed.replace(/[a-f0-9]/g, "");
  const macSeparators = separatorsOnly.length === 0 || /^[:.-]+$/.test(separatorsOnly);
  if (hex.length === 12 && macSeparators && (separatorsOnly.length > 0 || trimmed.length === 12)) {
    return hex.match(/.{2}/g)!.join(":");
  }
  if (!/^[a-z0-9:._-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function hashDeviceId(normalized: string, pepper: string): string {
  if (!pepper) throw new Error("Set PRESENCE_DEVICE_HASH_PEPPER on the server");
  return `hmac-sha256$${createHmac("sha256", pepper).update(normalized).digest("hex")}`;
}

function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isRadioKind(value: string): value is RadioKind {
  return (RADIO_KINDS as readonly string[]).includes(value);
}

export function readRadios(file: string): RadioRow[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { devices?: RadioRow[] };
    if (!Array.isArray(parsed.devices)) return [];
    return parsed.devices
      .filter(
        (row) =>
          typeof row?.id === "string" &&
          typeof row.deviceHash === "string" &&
          row.deviceHash.startsWith("hmac-sha256$") &&
          typeof row.personId === "string" &&
          isRadioKind(row.kind),
      )
      .map((row) => ({
        id: row.id,
        deviceHash: row.deviceHash,
        kind: row.kind,
        personId: row.personId,
        label: typeof row.label === "string" ? row.label : "",
        createdAt: row.createdAt,
        revokedAt: row.revokedAt ?? null,
        sessionStart: row.sessionStart ?? null,
        lastSeenAt: row.lastSeenAt ?? null,
        stationaryAt: row.stationaryAt ?? null,
      }));
  } catch {
    return [];
  }
}

function writeRadios(file: string, devices: RadioRow[]) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, devices }));
}

export function upsertRadio(
  file: string,
  input: { deviceId: string; personId: string; label: string; kind: RadioKind; now: number; pepper: string },
): RadioRow {
  const deviceId = normalizeDeviceId(input.deviceId);
  if (!deviceId) throw new Error("Check the device id");
  if (!input.label.trim()) throw new Error("Name the device");
  const deviceHash = hashDeviceId(deviceId, input.pepper);
  const devices = readRadios(file);
  const existing = devices.find((row) => row.revokedAt == null && hashesMatch(row.deviceHash, deviceHash));
  if (existing) {
    existing.personId = input.personId;
    existing.label = input.label.trim().slice(0, 80);
    existing.kind = input.kind;
    writeRadios(file, devices);
    return existing;
  }
  const session = blankSession();
  const row: RadioRow = {
    id: randomUUID(),
    deviceHash,
    kind: input.kind,
    personId: input.personId,
    label: input.label.trim().slice(0, 80),
    createdAt: input.now,
    revokedAt: null,
    ...session,
  };
  devices.push(row);
  writeRadios(file, devices);
  return row;
}

export function revokeRadio(file: string, id: string, now: number): RadioRow | null {
  const devices = readRadios(file);
  const row = devices.find((device) => device.id === id);
  if (!row) return null;
  if (row.revokedAt == null) row.revokedAt = now;
  writeRadios(file, devices);
  return row;
}

export function findLiveRadio(devices: readonly RadioRow[], presentedId: string, pepper: string): RadioRow | null {
  const normalized = normalizeDeviceId(presentedId);
  if (!normalized || !pepper) return null;
  let hash = "";
  try {
    hash = hashDeviceId(normalized, pepper);
  } catch {
    return null;
  }
  let found: RadioRow | null = null;
  for (const row of devices) {
    if (row.revokedAt != null) continue;
    if (hashesMatch(row.deviceHash, hash)) found = row;
  }
  return found;
}

export function writeRadioSession(file: string, id: string, session: SessionState): RadioRow | null {
  const devices = readRadios(file);
  const row = devices.find((device) => device.id === id);
  if (!row) return null;
  row.sessionStart = session.sessionStart;
  row.lastSeenAt = session.lastSeenAt;
  row.stationaryAt = session.stationaryAt;
  writeRadios(file, devices);
  return row;
}

export function publicRadio(row: RadioRow): {
  id: string;
  personId: string;
  label: string;
  kind: RadioKind;
  createdAt: number;
  revokedAt: number | null;
  stationaryAt: number | null;
} {
  return {
    id: row.id,
    personId: row.personId,
    label: row.label,
    kind: row.kind,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    stationaryAt: row.stationaryAt,
  };
}
