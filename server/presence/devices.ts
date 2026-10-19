import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { blankSession, type SessionState } from "./session";

export type DeviceRow = SessionState & {
  id: string;
  personId: string;
  label: string;
  tokenHash: string;
  /** Company id. Empty on devices enrolled before the team id was stamped. */
  teamId: string;
  /** Square team member this token may clock. Empty when the shop is not on Square. */
  squareTeamMemberId: string;
  /** Square location captured when the token was issued. */
  squareLocationId: string;
  /** Set when Square refuses this member. Cleared on the next accepted signal. */
  squareFlag: "deactivated" | "unassigned" | null;
  createdAt: number;
  revokedAt: number | null;
};

type DeviceFile = { version: 1; devices: DeviceRow[] };

function empty(): DeviceFile {
  return { version: 1, devices: [] };
}

export function hashDeviceToken(token: string): string {
  return `sha256$${createHash("sha256").update(token).digest("hex")}`;
}

export function deviceTokenMatches(token: string, stored: string): boolean {
  if (!token || !stored.startsWith("sha256$")) return false;
  const next = hashDeviceToken(token);
  const left = Buffer.from(next);
  const right = Buffer.from(stored);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function readDevices(file: string): DeviceRow[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { devices?: DeviceRow[] };
    if (!Array.isArray(parsed.devices)) return [];
    return parsed.devices
      .filter(
        (row) =>
          typeof row?.id === "string" &&
          typeof row.personId === "string" &&
          typeof row.tokenHash === "string" &&
          row.tokenHash.startsWith("sha256$"),
      )
      .map((row) => ({
        id: row.id,
        personId: row.personId,
        label: typeof row.label === "string" ? row.label : "",
        tokenHash: row.tokenHash,
        teamId: typeof row.teamId === "string" ? row.teamId : "",
        squareTeamMemberId: typeof row.squareTeamMemberId === "string" ? row.squareTeamMemberId : "",
        squareLocationId: typeof row.squareLocationId === "string" ? row.squareLocationId : "",
        squareFlag: row.squareFlag === "deactivated" || row.squareFlag === "unassigned" ? row.squareFlag : null,
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

function writeDevices(file: string, devices: DeviceRow[]) {
  mkdirSync(dirname(file), { recursive: true });
  const body: DeviceFile = { version: 1, devices };
  writeFileSync(file, JSON.stringify(body));
}

export function issueDevice(
  file: string,
  input: {
    personId: string;
    label: string;
    now: number;
    teamId?: string;
    squareTeamMemberId?: string;
    squareLocationId?: string;
  },
): { device: DeviceRow; token: string } {
  const token = `io_${randomBytes(32).toString("base64url")}`;
  const device: DeviceRow = {
    id: randomUUID(),
    personId: input.personId,
    label: input.label,
    tokenHash: hashDeviceToken(token),
    teamId: input.teamId?.trim() || "",
    squareTeamMemberId: input.squareTeamMemberId?.trim() || "",
    squareLocationId: input.squareLocationId?.trim() || "",
    squareFlag: null,
    createdAt: input.now,
    revokedAt: null,
    ...blankSession(),
  };
  const devices = readDevices(file);
  devices.push(device);
  writeDevices(file, devices);
  return { device, token };
}

export function revokeDevice(file: string, id: string, now: number): DeviceRow | null {
  const devices = readDevices(file);
  const row = devices.find((device) => device.id === id);
  if (!row) return null;
  if (row.revokedAt == null) row.revokedAt = now;
  writeDevices(file, devices);
  return row;
}

/** Live device for this token. Revoked tokens match nothing. */
export function findLiveDevice(devices: readonly DeviceRow[], token: string): DeviceRow | null {
  let found: DeviceRow | null = null;
  for (const device of devices) {
    if (device.revokedAt != null) continue;
    if (deviceTokenMatches(token, device.tokenHash)) found = device;
  }
  return found;
}

export function writeDeviceSession(file: string, id: string, session: SessionState): DeviceRow | null {
  const devices = readDevices(file);
  const row = devices.find((device) => device.id === id);
  if (!row) return null;
  row.sessionStart = session.sessionStart;
  row.lastSeenAt = session.lastSeenAt;
  row.stationaryAt = session.stationaryAt;
  writeDevices(file, devices);
  return row;
}

export function writeDeviceSquareFlag(
  file: string,
  id: string,
  flag: DeviceRow["squareFlag"],
): DeviceRow | null {
  const devices = readDevices(file);
  const row = devices.find((device) => device.id === id);
  if (!row) return null;
  row.squareFlag = flag;
  writeDevices(file, devices);
  return row;
}

export function publicDevice(device: DeviceRow): {
  id: string;
  personId: string;
  teamId: string;
  squareTeamMemberId: string;
  squareLocationId: string;
  squareFlag: DeviceRow["squareFlag"];
  label: string;
  createdAt: number;
  revokedAt: number | null;
  stationaryAt: number | null;
} {
  return {
    id: device.id,
    personId: device.personId,
    teamId: device.teamId,
    squareTeamMemberId: device.squareTeamMemberId,
    squareLocationId: device.squareLocationId,
    squareFlag: device.squareFlag,
    label: device.label,
    createdAt: device.createdAt,
    revokedAt: device.revokedAt,
    stationaryAt: device.stationaryAt,
  };
}

export function blankDeviceFile(): DeviceFile {
  return empty();
}
