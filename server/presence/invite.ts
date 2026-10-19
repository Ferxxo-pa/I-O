import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCompany } from "../company";
import { ioMode, lanPhoneUrl, relayDropUrl } from "../mode";
import { fenceFromEnv } from "./geo";
import { iphoneAutomationText, macroFile } from "@shared/cloud/enroll.ts";

export { iphoneAutomationText, macroFile };

const SHOP_ADDRESS = "403 E Ben White Blvd, Austin";

type InviteRow = {
  code: string;
  personId: string;
  name: string;
  deviceId: string;
  phoneUrl: string;
  sealed: string;
  createdAt: number;
  openedAt: number | null;
};

type InviteFile = { version: 1; invites: InviteRow[] };

export type InviteOpen = {
  token: string;
  url: string;
  name: string;
  ssid: string;
  address: string;
  lat: number;
  lng: number;
  radius: number;
  iphone: string;
  macro: { aiGenerated: number; macros: Macro[] };
};

type Macro = {
  m_name: string;
  m_GUID: 0;
  m_enabled: true;
  aiGenerated: 1;
  m_triggerList: object[];
  m_actionList: object[];
  m_constraintList: [];
};

function dataDir(): string {
  return process.env.DATA_DIR || join(process.cwd(), "data");
}

function invitePath(): string {
  return join(dataDir(), "presence-invites.json");
}

function inviteKey(): Buffer {
  const pepper = process.env.PRESENCE_DEVICE_HASH_PEPPER?.trim() || "io-invite";
  return createHash("sha256").update(`invite:${pepper}`).digest();
}

export function sealToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", inviteKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1$${iv.toString("base64url")}$${tag.toString("base64url")}$${ciphertext.toString("base64url")}`;
}

function unsealToken(sealed: string): string | null {
  const parts = sealed.split("$");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    const decipher = createDecipheriv("aes-256-gcm", inviteKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function readInvites(): InviteRow[] {
  const file = invitePath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { invites?: InviteRow[] };
    if (!Array.isArray(parsed.invites)) return [];
    return parsed.invites.filter(
      (row) =>
        typeof row?.code === "string" &&
        typeof row.personId === "string" &&
        typeof row.name === "string" &&
        typeof row.deviceId === "string" &&
        typeof row.phoneUrl === "string" &&
        typeof row.sealed === "string" &&
        row.sealed.startsWith("v1$"),
    );
  } catch {
    return [];
  }
}

function writeInvites(invites: InviteRow[]) {
  const file = invitePath();
  mkdirSync(dirname(file), { recursive: true });
  const body: InviteFile = { version: 1, invites };
  writeFileSync(file, JSON.stringify(body));
}

export function shopWifiSsid(): string {
  const name = getCompany().shop.wifiSsid?.trim();
  return name || "Premiere";
}

export function shopFence() {
  const fence = fenceFromEnv();
  return {
    lat: fence.lat,
    lng: fence.lng,
    radius: fence.radiusM,
    address: SHOP_ADDRESS,
  };
}

export function createInvite(input: {
  personId: string;
  name: string;
  deviceId: string;
  token: string;
  phoneUrl: string;
  now: number;
}): { code: string } {
  const code = randomBytes(18).toString("base64url");
  const invites = readInvites();
  invites.push({
    code,
    personId: input.personId,
    name: input.name,
    deviceId: input.deviceId,
    phoneUrl: input.phoneUrl,
    sealed: sealToken(input.token),
    createdAt: input.now,
    openedAt: null,
  });
  writeInvites(invites);
  return { code };
}

export function inviteByCode(code: string): { name: string; opened: boolean } | null {
  const row = readInvites().find((invite) => invite.code === code);
  if (!row) return null;
  return { name: row.name, opened: row.openedAt != null };
}

export function openInvite(code: string, now: number): InviteOpen | "used" | "missing" {
  const invites = readInvites();
  const row = invites.find((invite) => invite.code === code);
  if (!row) return "missing";
  if (row.openedAt != null) return "used";
  const token = unsealToken(row.sealed);
  if (!token) return "used";
  row.openedAt = now;
  writeInvites(invites);
  const fence = shopFence();
  const ssid = shopWifiSsid();
  const local = ioMode() === "local-relay";
  const relay = local ? relayDropUrl() : "";
  const fields = {
    url: local ? lanPhoneUrl() : row.phoneUrl,
    token,
    ssid,
    address: fence.address,
    lat: fence.lat,
    lng: fence.lng,
    radius: fence.radius,
    relayUrl: relay || undefined,
  };
  return {
    ...fields,
    name: row.name,
    iphone: iphoneAutomationText(fields),
    macro: macroFile(fields),
  };
}
