import { hmacSha256Base64, signaturesMatch as signaturesEqual } from "@shared/cloud/hmac.ts";

/** Square signs `notificationUrl + rawBody` with the subscription signature key. */
export function squareSignature(opts: {
  signatureKey: string;
  notificationUrl: string;
  rawBody: string;
}): string {
  return hmacSha256Base64(opts.signatureKey, opts.notificationUrl + opts.rawBody);
}

export function signaturesMatch(header: string, expected: string): boolean {
  return signaturesEqual(header, expected);
}
