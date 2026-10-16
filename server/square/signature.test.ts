import assert from "node:assert/strict";
import { signaturesMatch, squareSignature } from "./signature.ts";

const key = "shop-signature-key";
const url = "https://shop.example/api/square/webhook";
const raw = JSON.stringify({ type: "invoice.payment_made", data: { id: "evt" } });
const good = squareSignature({ signatureKey: key, notificationUrl: url, rawBody: raw });

assert.equal(signaturesMatch(good, good), true);
assert.equal(signaturesMatch("", good), false);
assert.equal(signaturesMatch("nope", good), false);

const tampered = squareSignature({
  signatureKey: key,
  notificationUrl: url,
  rawBody: raw.replace("evt", "other"),
});
assert.equal(signaturesMatch(tampered, good), false);
assert.notEqual(
  squareSignature({ signatureKey: "other-key", notificationUrl: url, rawBody: raw }),
  good,
);

console.log("signature ok");
