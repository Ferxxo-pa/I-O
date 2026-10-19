import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Hex HMAC of the raw body. Accepts a bare hex digest or a sha256= prefix. */
export function hmacMatches(secret: string, body: string, presented: string | null | undefined): boolean {
  if (!secret || !presented) return false;
  const given = presented.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]+$/.test(given)) return false;
  const expected = hmacSha256Hex(secret, body);
  const left = Buffer.from(given, "hex");
  const right = Buffer.from(expected, "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
