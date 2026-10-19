import { RELAY_TTL_MS } from "@shared/relayBox";

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

export function relaySecrets(): { url: string; secret: string } | null {
  const url = relayOrigin();
  const secret = process.env.RELAY_SHOP_SECRET?.trim() ?? "";
  if (!url || !secret) return null;
  return { url, secret };
}
