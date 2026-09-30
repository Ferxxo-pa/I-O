import { createHmac, timingSafeEqual } from "crypto";

/** Square signs `notificationUrl + rawBody` with the subscription signature key. */
export function squareSignature(opts: {
  signatureKey: string;
  notificationUrl: string;
  rawBody: string;
}): string {
  return createHmac("sha256", opts.signatureKey)
    .update(opts.notificationUrl + opts.rawBody)
    .digest("base64");
}

export function signaturesMatch(header: string, expected: string): boolean {
  const given = Buffer.from(header);
  const actual = Buffer.from(expected);
  if (given.length === 0 || given.length !== actual.length) return false;
  return timingSafeEqual(given, actual);
}
