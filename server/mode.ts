import { RELAY_TTL_MS, sealKeyBytes } from "@shared/relayBox";

export { RELAY_TTL_MS };

/** EZ runs local-relay unless IO_MODE=public. */
export function ioMode(): "local-relay" | "public" {
  return process.env.IO_MODE?.trim() === "public" ? "public" : "local-relay";
}

export function lanBaseUrl(): string {
  const set = process.env.LAN_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  return set || "http://io.local:5000";
}

export function lanPhoneUrl(): string {
  return `${lanBaseUrl()}/api/presence/phone`;
}

export function relayOrigin(): string {
  return process.env.RELAY_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
}

export function relayDropUrl(): string {
  const origin = relayOrigin();
  return origin ? `${origin}/drop` : "";
}

export function relayConfigured(): boolean {
  return relaySecrets() != null;
}

export function relaySecrets(): { url: string; secret: string; sealKey: string } | null {
  const url = relayOrigin();
  const secret = process.env.RELAY_SHOP_SECRET?.trim() ?? "";
  const sealKey = process.env.RELAY_SEAL_KEY?.trim() ?? "";
  if (!url || !secret || !sealKeyBytes(sealKey)) return null;
  return { url, secret, sealKey };
}
