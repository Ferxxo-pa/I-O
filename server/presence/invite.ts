import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deviceKey, deviceSealMaterial } from "@shared/relayBox";
import { getCompany } from "../company";
import { ioMode, lanPhoneUrl, relayDropUrl } from "../mode";
import { fenceFromEnv } from "./geo";

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
  deviceSeal?: string;
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

export function iphoneAutomationText(input: {
  url: string;
  token: string;
  ssid: string;
  address: string;
  lat: number;
  lng: number;
  radius: number;
  relayUrl?: string;
  deviceSeal?: string;
}): string {
  const header = `Authorization: Bearer ${input.token}`;
  const tagged = Boolean(input.relayUrl);
  const body = (event: "arrive" | "leave", trigger: "geo" | "wifi") =>
    tagged
      ? `{"event":"${event}","trigger":"${trigger}","ts":EVENT_ID,"eventId":"EVENT_ID"}`
      : `{"event":"${event}","trigger":"${trigger}"}`;
  const call = (event: "arrive" | "leave", trigger: "geo" | "wifi") =>
    [`POST ${input.url}`, header, body(event, trigger)].join("\n");
  const lead = tagged
    ? [
        "Capture the current time in milliseconds once. Use that same number as ts and eventId on every post of that firing.",
        "These posts go to the shop computer on Premiere.",
        "Shortcuts and MacroDroid cannot seal a cellular leave. Do not POST the event JSON to the mailbox.",
        input.deviceSeal ? `This phone's seal key, shown once: ${input.deviceSeal}` : "The shop seal key is not configured yet.",
        input.relayUrl ? `Mailbox POST ${input.relayUrl}` : "",
        'A client that can seal sends only {"box":"...","sig":"..."} with this phone\'s seal key. The mailbox never sees that key.',
        "",
      ].filter((line) => line !== "")
    : [];
  return [
    `Shop geofence — ${input.address}`,
    `Center ${input.lat}, ${input.lng}. Radius ${input.radius} m.`,
    "",
    ...lead,
    "Arrive",
    call("arrive", "geo"),
    "",
    "Leave",
    call("leave", "geo"),
    "",
    `Shop Wi-Fi — ${input.ssid}`,
    "",
    `Joined ${input.ssid}`,
    call("arrive", "wifi"),
    "",
    `Left ${input.ssid}`,
    call("leave", "wifi"),
  ].join("\n");
}

function httpAction(url: string, token: string, event: "arrive" | "leave", trigger: "geo" | "wifi", sig: string, tagged: boolean) {
  const body = tagged
    ? `{"event":"${event}","trigger":"${trigger}","ts":EVENT_ID,"eventId":"EVENT_ID"}`
    : JSON.stringify({ event, trigger });
  return {
    m_classType: "HttpRequestAction",
    m_url: url,
    m_httpMethod: "POST",
    m_contentType: "application/json",
    m_body: body,
    m_headerKeys: ["Authorization"],
    m_headerValues: [`Bearer ${token}`],
    m_SIGUID: sig,
    m_constraintList: [{ m_classType: "TriggerThatInvokedConstraint", m_SIGUID: `${sig}c` }],
  };
}

function actionUrls(url: string, _relayUrl: string | undefined, _event: "arrive" | "leave"): string[] {
  return [url];
}

export function macroFile(input: {
  url: string;
  token: string;
  ssid: string;
  address: string;
  lat: number;
  lng: number;
  radius: number;
  relayUrl?: string;
}): InviteOpen["macro"] {
  const tagged = Boolean(input.relayUrl);
  const actions = (event: "arrive" | "leave", trigger: "geo" | "wifi", sig: string) =>
    actionUrls(input.url, input.relayUrl, event).map((url, index) =>
      httpAction(url, input.token, event, trigger, `${sig}${index === 0 ? "a" : "b"}`, tagged),
    );
  const geo = (name: string, enter: boolean, event: "arrive" | "leave", sig: string): Macro => ({
    m_name: name,
    m_GUID: 0,
    m_enabled: true,
    aiGenerated: 1,
    m_triggerList: [
      {
        m_classType: "GeofenceTrigger",
        m_latitude: input.lat,
        m_longitude: input.lng,
        m_radius: input.radius,
        m_triggerOnEnter: enter,
        m_locationName: input.address,
        m_SIGUID: sig,
      },
    ],
    m_actionList: actions(event, "geo", sig),
    m_constraintList: [],
  });
  const wifi = (name: string, state: 2 | 3, event: "arrive" | "leave", sig: string): Macro => ({
    m_name: name,
    m_GUID: 0,
    m_enabled: true,
    aiGenerated: 1,
    m_triggerList: [
      {
        m_classType: "WifiConnectionTrigger",
        m_SSID: input.ssid,
        m_wifiState: state,
        m_SIGUID: sig,
      },
    ],
    m_actionList: actions(event, "wifi", sig),
    m_constraintList: [],
  });
  return {
    aiGenerated: 1,
    macros: [
      geo("EZ Designs geofence arrive", true, "arrive", "112233445566771"),
      geo("EZ Designs geofence leave", false, "leave", "112233445566772"),
      wifi(`EZ Designs ${input.ssid} join`, 2, "arrive", "112233445566773"),
      wifi(`EZ Designs ${input.ssid} leave`, 3, "leave", "112233445566774"),
    ],
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

export async function openInvite(code: string, now: number): Promise<InviteOpen | "used" | "missing"> {
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
  const master = process.env.RELAY_SEAL_KEY?.trim() ?? "";
  let deviceSeal = "";
  if (local && relay && master) {
    try {
      deviceSeal = await deviceSealMaterial(master, await deviceKey(token));
    } catch {
      deviceSeal = "";
    }
  }
  const fields = {
    url: local ? lanPhoneUrl() : row.phoneUrl,
    token,
    ssid,
    address: fence.address,
    lat: fence.lat,
    lng: fence.lng,
    radius: fence.radius,
    relayUrl: relay || undefined,
    deviceSeal: deviceSeal || undefined,
  };
  return {
    ...fields,
    name: row.name,
    iphone: iphoneAutomationText(fields),
    macro: macroFile(fields),
    ...(deviceSeal ? { deviceSeal } : {}),
  };
}
