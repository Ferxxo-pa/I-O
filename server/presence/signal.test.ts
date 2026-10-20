import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shopDateStart } from "@shared/presence.ts";
import { setConsent, consentActive, readConsent } from "./consent.ts";
import { signalConfigFromEnv } from "./config.ts";
import { hashDeviceToken } from "./devices.ts";
import { phoneSetupSnippet } from "./phone.ts";
import { hashDeviceId, normalizeDeviceId } from "./radios.ts";
import { hmacMatches, hmacSha256Hex } from "./sign.ts";
import { latchedOvernight, withinCollection } from "./session.ts";
import { dayConfigFromEnv } from "./config.ts";
import { holdsPresence, noteSight, shouldAutoClose, shouldQuietLeave, watchHolds } from "./watch.ts";

const day = dayConfigFromEnv({});
const start = shopDateStart("2026-10-14");
const at = (hours: number, minutes = 0) => start + (hours * 60 + minutes) * 60_000;

assert.equal(signalConfigFromEnv({}).quietMs, 15 * 60 * 1000);
assert.equal(signalConfigFromEnv({}).autoCloseMin, 19 * 60);
assert.equal(signalConfigFromEnv({}).phoneDedupeMs, 2 * 60 * 1000);
assert.equal(signalConfigFromEnv({ PRESENCE_SIGNAL_QUIET_MS: "0" }).quietMs, 15 * 60 * 1000);

assert.equal(withinCollection(at(7), day, 2 * 60 * 60 * 1000), true);
assert.equal(withinCollection(at(6, 59), day, 2 * 60 * 60 * 1000), false);
assert.equal(withinCollection(at(19), day, 2 * 60 * 60 * 1000), true);
assert.equal(withinCollection(at(19, 1), day, 2 * 60 * 60 * 1000), false);

const colon = normalizeDeviceId("AA:BB:CC:DD:EE:FF");
const dashed = normalizeDeviceId("aa-bb-cc-dd-ee-ff");
assert.equal(colon, dashed);
const hashed = hashDeviceId(colon!, "pepper");
assert.equal(hashed, hashDeviceId(dashed!, "pepper"));
assert.equal(hashed.includes("aa:bb"), false);
assert.equal(hashed.startsWith("hmac-sha256$"), true);

const token = "io_example_token_value";
assert.equal(hashDeviceToken(token).includes(token), false);

const secret = "wifi-secret";
const body = '{"source":"wifi"}';
assert.equal(hmacMatches(secret, body, hmacSha256Hex(secret, body)), true);
assert.equal(hmacMatches(secret, body, hmacSha256Hex("other", body)), false);

const dir = mkdtempSync(join(tmpdir(), "io-consent-"));
const consentFile = join(dir, "consent.json");
assert.equal(consentActive(readConsent(consentFile), "ada"), false);
setConsent(consentFile, "ada", true, 10);
assert.equal(consentActive(readConsent(consentFile), "ada"), true);
assert.equal(readFileSync(consentFile, "utf8").includes("pin"), false);
setConsent(consentFile, "ada", false, 20);
assert.equal(consentActive(readConsent(consentFile), "ada"), false);

const latched = noteSight(null, { source: "phone", sourceId: "dev:geo", at: at(9), present: true, latch: true });
assert.equal(watchHolds(latched, at(18), 15 * 60 * 1000), true);
assert.equal(
  shouldQuietLeave({ phase: "working", clockInTs: at(9), watch: latched, now: at(18), quietMs: 15 * 60 * 1000 }),
  null,
);
const released = noteSight(latched, { source: "phone", sourceId: "dev:geo", at: at(17), present: false, latch: true });
assert.equal(holdsPresence(released.sources["phone:dev:geo"]!, at(17, 20), 15 * 60 * 1000), false);
assert.equal(
  shouldQuietLeave({ phase: "working", clockInTs: at(9), watch: released, now: at(17, 10), quietMs: 15 * 60 * 1000 }),
  null,
);
assert.equal(
  shouldQuietLeave({ phase: "working", clockInTs: at(9), watch: released, now: at(17, 15), quietMs: 15 * 60 * 1000 }),
  at(17),
);
assert.equal(
  shouldAutoClose({
    phase: "working",
    clockInTs: at(9),
    watch: latched,
    now: at(19),
    autoCloseAt: at(19),
    quietMs: 15 * 60 * 1000,
  }),
  at(19),
);
assert.equal(latchedOvernight(at(16), at(8) + 24 * 60 * 60 * 1000, day.tz), true);
assert.equal(latchedOvernight(at(9), at(18), day.tz), false);

const snippet = phoneSetupSnippet({
  url: "https://shop.example/api/presence/phone",
  token: "io_token",
  name: "Ada",
});
assert.equal(snippet.includes("https://shop.example/api/presence/phone"), true);
assert.equal(snippet.includes("Authorization: Bearer io_token"), true);
assert.equal(snippet.includes('{"event":"arrive","trigger":"geo"}'), true);
assert.equal(snippet.includes('{"event":"leave","trigger":"wifi"}'), true);
assert.equal(snippet.includes("hourly"), false);

console.log("presence signal ok");
