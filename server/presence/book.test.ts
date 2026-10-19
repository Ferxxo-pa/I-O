import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DAY, shopDateStart, type DayConfig } from "@shared/presence.ts";
import { PresenceBook } from "./book.ts";
import { SHOP_POINT, type FenceConfig } from "./geo.ts";
import { appendPunchLog, readPunchLog } from "./log.ts";
import { personIdForPin, writePinHash } from "./pins.ts";
import type { MirrorTransport, SquarePerson } from "./square.ts";

const config: DayConfig = { ...DEFAULT_DAY, openWeekdays: [...DEFAULT_DAY.openWeekdays] };
const fence: FenceConfig = {
  lat: SHOP_POINT.lat,
  lng: SHOP_POINT.lng,
  radiusM: 120,
  maxAccuracyM: 75,
  maxAgeMs: 30_000,
  maxFutureMs: 15_000,
};
let now = shopDateStart("2026-10-14") + 9 * 3_600_000;
const ada = { id: "ada", name: "Ada" };
const ben = { id: "ben", name: "Ben" };
const inside = { lat: fence.lat, lng: fence.lng, accuracy: 15, capturedAt: now };
const outside = { lat: fence.lat + 0.05, lng: fence.lng, accuracy: 15, capturedAt: now };
const square: SquarePerson = {
  personId: "ada",
  teamMemberId: "TM_ADA",
  jobId: "JOB_ADA",
  lunchBreakTypeId: "BR_LUNCH",
  shortBreakTypeId: "BR_SHORT",
};

let fetches = 0;
const transport: MirrorTransport = {
  mode: "dry_run",
  request: async () => {
    fetches += 1;
    return {};
  },
};
const records: ReturnType<PresenceBook["list"]> = [];
const book = new PresenceBook({
  config,
  fence,
  now: () => now,
  records,
  corrections: [],
  links: [],
  squarePeople: [square],
  locationId: "L1",
  append: (row) => records.push(row),
  appendCorrection: () => {},
  saveLink: () => {},
  transport: () => transport,
});

const rejected = await book.punch({
  person: ada,
  claimedPersonId: null,
  type: "arrive",
  fix: { ...outside, capturedAt: now },
  source: "phone",
  desk: false,
});
assert.equal(rejected.record.accepted, false);
assert.equal(rejected.record.reason, "outside_fence");
assert.equal(rejected.effect, "none");
assert.equal(book.day("ada", now).phase, "out");
assert.equal(fetches, 0);

const stolen = await book.punch({
  person: ada,
  claimedPersonId: "ben",
  type: "arrive",
  fix: { ...inside, capturedAt: now },
  source: "phone",
  desk: false,
});
assert.equal(stolen.record.accepted, false);
assert.equal(stolen.record.reason, "wrong_person");
assert.equal(book.day("ada").phase, "out");
assert.equal(book.day("ben").phase, "out");

const opened = await book.punch({
  person: ada,
  claimedPersonId: "ada",
  type: "arrive",
  fix: { ...inside, capturedAt: now },
  source: "iban",
  desk: false,
});
assert.equal(opened.record.accepted, true);
assert.equal(opened.record.type, "arrive");
assert.equal(opened.record.source, "iban");
assert.equal(opened.effect, "clock_in");
assert.equal(opened.day.present, true);
const plans = await book.mirror(["ada"], now);
assert.equal(plans.length, 1);
assert.equal(plans[0]?.op, "open");
assert.equal(JSON.stringify(plans[0]?.body).includes("hourly_rate"), false);
assert.equal(JSON.stringify(plans[0]?.body).includes("TM_ADA"), true);
assert.equal(fetches, 0);

const stale = await book.punch({
  person: ada,
  claimedPersonId: null,
  type: "leave",
  fix: { ...inside, capturedAt: now - 60_000 },
  source: "phone",
  desk: false,
});
assert.equal(stale.record.accepted, false);
assert.equal(stale.record.reason, "stale_fix");
assert.equal(book.day("ada").phase, "working");

now += 11 * 60_000;
const left = await book.punch({
  person: ada,
  claimedPersonId: null,
  type: "leave",
  fix: { ...inside, capturedAt: now },
  source: "phone",
  desk: false,
});
assert.equal(left.record.accepted, true);
assert.equal(book.day("ada").phase, "pending");
now += 11 * 60_000;
assert.equal(book.day("ada").phase, "break");
assert.equal(book.day("ada").workedMs, 11 * 60_000);

const view = book.view([ada, ben], "ada", now);
assert.equal(view.dots.find((dot) => dot.personId === "ada")?.present, false);
assert.equal(view.dots.find((dot) => dot.personId === "ada")?.label, "On break");
assert.equal(view.dots.find((dot) => dot.personId === "ben")?.label, "Out");
assert.equal(view.streakDays, 1);
assert.equal(view.week.workedDays, 1);
assert.equal(view.squareMode, "dry_run");
assert.equal(JSON.stringify(view).includes("TM_ADA"), false);
assert.equal(JSON.stringify(view).includes(String(fence.lat)), false);

const pending = book.requestCorrection(ada, now - 60_000, now);
assert.equal(pending.status, "pending");
assert.equal(book.day("ada").phase, "break");
const approved = await book.decideCorrection(pending.id, "approved", now);
assert.equal(approved.status, "approved");
assert.equal(book.day("ada").phase, "closed");
assert.throws(() => book.requestCorrection(ben, now, now), /No open day/);

const dir = mkdtempSync(join(tmpdir(), "io-presence-"));
const file = join(dir, "presence-punches.jsonl");
appendPunchLog(file, opened.record);
const before = readFileSync(file, "utf8");
appendPunchLog(file, rejected.record);
const after = readFileSync(file, "utf8");
assert.equal(after.startsWith(before), true);
assert.equal(readPunchLog(file).length, 2);
assert.equal(after.includes("hourly"), false);

const pinFile = writePinHash(join(dir, "presence-pins.json"), "ada", "2468");
const pinBody = readFileSync(join(dir, "presence-pins.json"), "utf8");
assert.equal(pinBody.includes("2468"), false);
assert.equal(personIdForPin("2468", pinFile.pins), "ada");
assert.equal(personIdForPin("0000", pinFile.pins), null);

const teamConfig: DayConfig = { ...config, shopDayMinPeople: 2, shopDayMinMinutes: 30 };
let teamNow = shopDateStart("2026-10-13") + 9 * 3_600_000;
const teamRows: ReturnType<PresenceBook["list"]> = [];
const team = new PresenceBook({
  config: teamConfig,
  fence,
  now: () => teamNow,
  records: teamRows,
  corrections: [],
  links: [],
  squarePeople: [],
  locationId: "L1",
  append: (row) => teamRows.push(row),
  appendCorrection: () => {},
  saveLink: () => {},
  transport: () => transport,
});
const teamFix = () => ({ lat: fence.lat, lng: fence.lng, accuracy: 15, capturedAt: teamNow });
await team.punch({
  person: ada,
  claimedPersonId: null,
  type: "arrive",
  fix: teamFix(),
  source: "phone",
  desk: false,
});
assert.equal(team.view([ada, ben], null, teamNow).streakDays, 0);
assert.equal(team.view([ada, ben], null, teamNow).week.workedDays, 0);
const blocked = await team.punch({
  person: ben,
  claimedPersonId: null,
  type: "arrive",
  fix: { ...teamFix(), lat: fence.lat + 0.05 },
  source: "phone",
  desk: false,
});
assert.equal(blocked.record.accepted, false);
assert.equal(team.view([ada, ben], null, teamNow).streakDays, 0);
await team.punch({
  person: ben,
  claimedPersonId: null,
  type: "arrive",
  fix: teamFix(),
  source: "phone",
  desk: false,
});
assert.equal(team.view([ada, ben], null, teamNow).streakDays, 0);
teamNow += 29 * 60_000;
assert.equal(team.view([ada, ben], null, teamNow).streakDays, 0);
teamNow += 60_000;
const met = team.view([ada, ben], null, teamNow);
assert.equal(met.streakDays, 1);
assert.equal(met.week.workedDays, 1);
assert.equal(met.week.days[1]?.worked, true);
assert.equal(met.squareMode, "dry_run");
assert.equal(fetches, 0);

teamNow = shopDateStart("2026-10-14") + 9 * 3_600_000;
await team.punch({
  person: ada,
  claimedPersonId: null,
  type: "arrive",
  fix: teamFix(),
  source: "phone",
  desk: false,
});
const still = team.view([ada, ben], null, teamNow);
assert.equal(still.streakDays, 1);
assert.equal(still.week.workedDays, 1);
assert.equal(still.week.days[2]?.worked, false);

console.log("presence book ok");
