import assert from "node:assert/strict";
import { signaturesMatch, hmacSha256Base64, sha256Hex } from "./hmac.ts";
import { squareSignature } from "../../server/square/signature.ts";
import {
  alreadyBooked,
  autoCloseMoment,
  canonicalOpenId,
  dueAutoClose,
  needsNewTimecard,
  planRemoteTimecard,
  wageWriteBlocked,
  type ShiftLike,
} from "./clockPlan.ts";
import { planPhone } from "./phonePlan.ts";
import { originAllowed } from "./cors.ts";
import { redactLog } from "./audit.ts";
import { rowsFromIoState } from "./importState.ts";
import { slideWindow } from "./rate.ts";
import { shopDateStart } from "../presence.ts";
import { noteSight } from "./watch.ts";

const key = "shop-signature-key";
const url = "https://shop.example/api/square/webhook";
const raw = JSON.stringify({ type: "invoice.payment_made", data: { id: "evt" } });
const good = squareSignature({ signatureKey: key, notificationUrl: url, rawBody: raw });
assert.equal(good, hmacSha256Base64(key, url + raw));
assert.equal(signaturesMatch(good, good), true);
assert.equal(signaturesMatch("nope", good), false);
assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

const open: ShiftLike = {
  personId: "ada",
  name: "Ada",
  hourlyCents: 2000,
  clockedIn: true,
  clockedInAt: 1,
  hourSegmentStartedAt: 1,
  outputCents: 0,
  timecardId: "tc-1",
  holdAt: null,
  managedBy: null,
  source: "phone-geo",
  review: null,
};
assert.equal(planRemoteTimecard(open, { personId: "ada", name: "Ada", hourlyCents: 2000, timecardId: "tc-1", open: true, startedAt: 1 }, 2, 2000).action, "noop");
assert.equal(needsNewTimecard({ clockedIn: true, localTimecardId: "tc-1", remoteOpenIds: ["tc-1"] }), false);
assert.equal(needsNewTimecard({ clockedIn: false, localTimecardId: null, remoteOpenIds: [] }), true);
assert.equal(canonicalOpenId([{ id: "b", startedAt: 20 }, { id: "a", startedAt: 10 }]), "a");
assert.equal(wageWriteBlocked("POST", "/v2/team-members/ada/wage-setting"), true);
assert.equal(wageWriteBlocked("GET", "/v2/team-members/ada/wage-setting"), false);
assert.equal(alreadyBooked(new Set(["inv:paid"]), "inv", "paid"), true);

const day = shopDateStart("2026-10-19");
const ten = day + 10 * 60 * 60 * 1000;
const seven = autoCloseMoment(ten, 19 * 60, "America/Chicago");
assert.equal(seven, day + 19 * 60 * 60 * 1000);
const watch = noteSight(null, { source: "phone", sourceId: "dev:geo", at: ten, present: true, latch: true });
const closeAt = dueAutoClose({
  shift: open,
  watch,
  phase: "working",
  now: seven + 60_000,
  autoCloseAt: seven,
  quietMs: 15 * 60 * 1000,
});
assert.equal(closeAt, seven);

const leave = planPhone({
  now: ten + 3 * 60 * 60 * 1000,
  signal: { event: "leave", trigger: "geo", eventId: "evt-leave-1" },
  deviceId: "dev",
  personId: "ada",
  maxAgeMs: 600_000,
  maxFutureMs: 15_000,
  dedupeMs: 120_000,
  inWindow: true,
  device: { id: "dev", personId: "ada", squareTeamMemberId: "ada", stationaryAt: null, sessionStart: ten, squareFlag: null },
  person: { id: "ada", name: "Ada", hourlyCents: 2000, squareTeamMemberId: "ada", consent: true },
  watch,
  shift: { clockedIn: true, holdAt: null, managedBy: null },
  quietMs: 900_000,
  stationaryMs: 14 * 60 * 60 * 1000,
});
assert.equal(leave.body.applied, "exit");
assert.equal(leave.hold?.personId, "ada");
assert.ok(leave.body.reason == null);

assert.equal(originAllowed("https://evil.example", ["https://io.example"]), false);
assert.equal(originAllowed(null, ["https://io.example"]), true);
assert.match(redactLog("Bearer abcdefghijklmnopqrstuvwxyz and ada@shop.test"), /Bearer \[redacted\]/);
assert.doesNotMatch(redactLog("clock_in pin"), /ada/i);

const imported = rowsFromIoState({
  version: 1,
  ownerKey: "owner-secret",
  company: { id: "shop-1", name: "EZ", code: "EZ1234", locationId: "L1", people: [{ id: "ada", name: "Ada", hourlyCents: 2000 }] },
  shifts: [{ personId: "ada", name: "Ada", hourlyCents: 2000, clockedIn: true, timecardId: "tc-1" }],
  fight: { pinHash: "scrypt$abc$def" },
});
assert.equal(imported.company.id, "shop-1");
assert.equal(imported.people[0].name, "Ada");
assert.equal(imported.sessions[0].timecardId, "tc-1");
assert.equal(imported.company.pinHash, "scrypt$abc$def");

const windowed = slideWindow([], 1_000, 60_000, 1);
assert.equal(windowed.limited, false);
assert.equal(slideWindow(windowed.next, 1_100, 60_000, 1).limited, true);

console.log("cloud shared ok");
