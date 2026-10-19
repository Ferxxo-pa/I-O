import assert from "node:assert/strict";
import { zonedParts } from "@shared/fight";
import { dayConfigFromEnv } from "./config.ts";
import {
  DEFAULT_DAY,
  cutoffMinutes,
  deriveDay,
  presenceStreak,
  presenceWeek,
  shopDateStart,
  shopWorkedDates,
  type DayConfig,
  type DayEvent,
} from "@shared/presence.ts";

const date = "2026-10-14";
const start = shopDateStart(date);
const config: DayConfig = { ...DEFAULT_DAY, openWeekdays: [...DEFAULT_DAY.openWeekdays] };

function at(hours: number, minutes = 0): number {
  return start + (hours * 60 + minutes) * 60_000;
}

assert.equal(zonedParts(at(9), config.tz).key, date);
assert.equal(zonedParts(at(9), config.tz).hour, 9);
assert.equal(cutoffMinutes(config), 19 * 60);

const onTime = deriveDay([{ type: "arrive", ts: at(9) }], config, at(9, 5));
assert.equal(onTime.phase, "working");
assert.equal(onTime.present, true);
assert.equal(onTime.early, false);
assert.equal(onTime.late, false);
assert.equal(onTime.workedMs, 5 * 60_000);

const early = deriveDay([{ type: "arrive", ts: at(5, 30) }], config, at(5, 40));
assert.equal(early.phase, "working");
assert.equal(early.early, true);
assert.equal(early.clockInTs, at(5, 30));

const late = deriveDay([{ type: "arrive", ts: at(12, 30) }], config, at(12, 40));
assert.equal(late.phase, "working");
assert.equal(late.late, true);

const hop: DayEvent[] = [
  { type: "arrive", ts: at(9) },
  { type: "leave", ts: at(10) },
  { type: "arrive", ts: at(10, 9) },
];
const ignored = deriveDay(hop, config, at(10, 30));
assert.equal(ignored.phase, "working");
assert.equal(ignored.breaks.length, 0);
assert.equal(ignored.workedMs, 90 * 60_000);

const boundary = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(10) },
    { type: "arrive", ts: at(10) + config.minAwayMs },
  ],
  config,
  at(10) + config.minAwayMs,
);
assert.equal(boundary.phase, "working");
assert.equal(boundary.breaks.length, 1);
assert.equal(boundary.breaks[0].kind, "short");
assert.equal(boundary.workedMs, 60 * 60_000);

const lunch = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(11, 30) },
  ],
  config,
  at(11, 50),
);
assert.equal(lunch.phase, "break");
assert.equal(lunch.present, false);
assert.equal(lunch.breakKind, "lunch");
assert.equal(lunch.workedMs, 150 * 60_000);

const short = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(15) },
  ],
  config,
  at(15, 20),
);
assert.equal(short.phase, "break");
assert.equal(short.breakKind, "short");
assert.equal(short.workedMs, 6 * 3_600_000);

const back = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(11, 30) },
    { type: "arrive", ts: at(12) },
  ],
  config,
  at(12, 10),
);
assert.equal(back.phase, "working");
assert.equal(back.workedMs, 150 * 60_000 + 10 * 60_000);

const stillOut = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(16) },
  ],
  config,
  at(18, 30),
);
assert.equal(stillOut.phase, "break");
assert.equal(stillOut.closedAt, null);

const closed = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(16) },
  ],
  config,
  at(19),
);
assert.equal(closed.phase, "closed");
assert.equal(closed.present, false);
assert.equal(closed.closedAt, at(16));
assert.equal(closed.workedMs, 7 * 3_600_000);

const afterHours = deriveDay(
  [
    { type: "arrive", ts: at(20) },
    { type: "leave", ts: at(20, 30) },
  ],
  config,
  at(20, 30),
);
assert.equal(afterHours.phase, "closed");
assert.equal(afterHours.late, true);
assert.equal(afterHours.closedAt, at(20, 30));
assert.equal(afterHours.workedMs, 30 * 60_000);

const forgot: DayEvent[] = [
  { type: "arrive", ts: at(9) },
  { type: "leave", ts: at(17), closesDay: true },
];
const corrected = deriveDay(forgot, config, at(17, 5));
assert.equal(corrected.phase, "closed");
assert.equal(corrected.closedAt, at(17));
assert.equal(corrected.workedMs, 8 * 3_600_000);

const worked = new Set(["2026-10-13", "2026-10-14"]);
assert.equal(
  presenceStreak({ today: "2026-10-15", worked, openWeekdays: config.openWeekdays, tz: config.tz }),
  2,
);
assert.equal(
  presenceStreak({ today: "2026-10-14", worked, openWeekdays: config.openWeekdays, tz: config.tz }),
  2,
);
assert.equal(
  presenceStreak({
    today: "2026-10-16",
    worked: new Set(["2026-10-13"]),
    openWeekdays: config.openWeekdays,
    tz: config.tz,
  }),
  0,
);

const week = presenceWeek({ today: date, worked: new Set([date]), openWeekdays: config.openWeekdays, tz: config.tz });
assert.equal(week.days.length, 7);
assert.equal(week.workedDays, 1);
assert.equal(week.openDays, 5);
assert.equal(week.days[2]?.worked, true);
assert.equal(week.days[2]?.label, "W");
assert.equal(week.filledPct, 0.2);

const blankDays = dayConfigFromEnv({});
assert.deepEqual(blankDays.openWeekdays, [1, 2, 3, 4, 5]);
assert.equal(blankDays.tz, DEFAULT_DAY.tz);
assert.equal(blankDays.shopDayMinPeople, 1);
assert.equal(blankDays.shopDayMinMinutes, null);
const customDays = dayConfigFromEnv({ PRESENCE_OPEN_WEEKDAYS: "0, 6," });
assert.deepEqual(customDays.openWeekdays, [0, 6]);
const teamDays = dayConfigFromEnv({
  PRESENCE_SHOP_DAY_MIN_PEOPLE: "2",
  PRESENCE_SHOP_DAY_MIN_MINUTES: "45",
});
assert.equal(teamDays.shopDayMinPeople, 2);
assert.equal(teamDays.shopDayMinMinutes, 45);
const junkDays = dayConfigFromEnv({
  PRESENCE_SHOP_DAY_MIN_PEOPLE: "0",
  PRESENCE_SHOP_DAY_MIN_MINUTES: "nope",
});
assert.equal(junkDays.shopDayMinPeople, 1);
assert.equal(junkDays.shopDayMinMinutes, null);
const blankMinutes = dayConfigFromEnv({ PRESENCE_SHOP_DAY_MIN_MINUTES: "  " });
assert.equal(blankMinutes.shopDayMinMinutes, null);

type ShopRow = {
  personId: string;
  accepted: boolean;
  type: "arrive" | "leave";
  ts: number;
  closesDay?: boolean;
};

function row(personId: string, type: "arrive" | "leave", ts: number, accepted = true): ShopRow {
  return { personId, accepted, type, ts };
}

const solo = shopWorkedDates([row("ada", "arrive", at(9))], config, at(9));
assert.equal(solo.has(date), true);

const rejectedOnly = shopWorkedDates([row("ada", "arrive", at(9), false)], config, at(10));
assert.equal(rejectedOnly.has(date), false);

const shortSolo = shopWorkedDates(
  [row("ada", "arrive", at(9)), row("ada", "leave", at(9, 20))],
  { ...config, shopDayMinMinutes: 60 },
  at(10),
);
assert.equal(shortSolo.has(date), false);

const beforeOpen = shopWorkedDates([row("ada", "arrive", at(5, 30))], config, at(6));
assert.equal(beforeOpen.has(date), true);
const afterClose = shopWorkedDates([row("ada", "arrive", at(20)), row("ada", "leave", at(21))], config, at(21));
assert.equal(afterClose.has(date), true);

const pairRule: DayConfig = { ...config, shopDayMinPeople: 2, shopDayMinMinutes: null };
const afterHoursTogether = shopWorkedDates(
  [row("ada", "arrive", at(20)), row("ben", "arrive", at(20, 15))],
  pairRule,
  at(20, 15),
);
assert.equal(afterHoursTogether.has(date), true);
const onePerson = shopWorkedDates(
  [row("ada", "arrive", at(9)), row("ada", "leave", at(17))],
  pairRule,
  at(17),
);
assert.equal(onePerson.has(date), false);

const apart = shopWorkedDates(
  [
    row("ada", "arrive", at(9)),
    row("ada", "leave", at(11)),
    row("ben", "arrive", at(13)),
    row("ben", "leave", at(15)),
  ],
  pairRule,
  at(16),
);
assert.equal(apart.has(date), false);

const togetherNow = shopWorkedDates(
  [row("ada", "arrive", at(9)), row("ben", "arrive", at(10))],
  pairRule,
  at(10),
);
assert.equal(togetherNow.has(date), true);

const minuteRule: DayConfig = { ...config, shopDayMinPeople: 2, shopDayMinMinutes: 90 };
const shortOverlap = shopWorkedDates(
  [row("ada", "arrive", at(9)), row("ben", "arrive", at(9)), row("ben", "leave", at(10))],
  minuteRule,
  at(12),
);
assert.equal(shortOverlap.has(date), false);

const longOverlap = shopWorkedDates(
  [
    row("ada", "arrive", at(9)),
    row("ben", "arrive", at(9)),
    row("ben", "leave", at(10)),
    row("ben", "arrive", at(11)),
  ],
  minuteRule,
  at(12),
);
assert.equal(longOverlap.has(date), true);

const lunchGap = shopWorkedDates(
  [
    row("ada", "arrive", at(9)),
    row("ben", "arrive", at(9)),
    row("ben", "leave", at(10)),
    row("ben", "arrive", at(11)),
  ],
  { ...config, shopDayMinPeople: 2, shopDayMinMinutes: 150 },
  at(12),
);
assert.equal(lunchGap.has(date), false);

const nextStart = shopDateStart("2026-10-15");
const lateNight = at(23, 30);
const afterMidnight = nextStart + 30 * 60_000;
assert.equal(zonedParts(lateNight, config.tz).key, date);
assert.equal(zonedParts(afterMidnight, config.tz).key, "2026-10-15");
const chicagoSplit = shopWorkedDates(
  [row("ada", "arrive", lateNight), row("ben", "arrive", afterMidnight)],
  config,
  afterMidnight,
);
assert.equal(chicagoSplit.has(date), true);
assert.equal(chicagoSplit.has("2026-10-15"), true);
const notTogetherAcrossMidnight = shopWorkedDates(
  [row("ada", "arrive", lateNight), row("ben", "arrive", afterMidnight)],
  pairRule,
  afterMidnight,
);
assert.equal(notTogetherAcrossMidnight.has(date), false);
assert.equal(notTogetherAcrossMidnight.has("2026-10-15"), false);

const monday = "2026-10-12";
const tuesday = "2026-10-13";
const wednesday = date;
function dayAt(key: string, hours: number, minutes = 0): number {
  return shopDateStart(key) + (hours * 60 + minutes) * 60_000;
}
const weekPunches: ShopRow[] = [
  row("ada", "arrive", dayAt(monday, 9)),
  row("ben", "arrive", dayAt(monday, 9, 10)),
  row("ada", "arrive", dayAt(tuesday, 9)),
  row("ben", "arrive", dayAt(tuesday, 9, 5)),
  row("ada", "arrive", dayAt(wednesday, 9)),
];
const shopDays = shopWorkedDates(weekPunches, pairRule, dayAt(wednesday, 10));
assert.equal(shopDays.has(monday), true);
assert.equal(shopDays.has(tuesday), true);
assert.equal(shopDays.has(wednesday), false);
assert.equal(
  presenceStreak({ today: wednesday, worked: shopDays, openWeekdays: config.openWeekdays, tz: config.tz }),
  2,
);
assert.equal(
  presenceStreak({ today: tuesday, worked: shopDays, openWeekdays: config.openWeekdays, tz: config.tz }),
  2,
);
const shopWeek = presenceWeek({
  today: wednesday,
  worked: shopDays,
  openWeekdays: config.openWeekdays,
  tz: config.tz,
});
assert.equal(shopWeek.workedDays, 2);
assert.equal(shopWeek.days[0]?.worked, true);
assert.equal(shopWeek.days[1]?.worked, true);
assert.equal(shopWeek.days[2]?.worked, false);
assert.equal(shopWeek.filledPct, 0.4);

const missed = shopWorkedDates(
  [row("ada", "arrive", dayAt(monday, 9)), row("ben", "arrive", dayAt(monday, 9))],
  pairRule,
  dayAt(wednesday, 9),
);
assert.equal(
  presenceStreak({ today: wednesday, worked: missed, openWeekdays: config.openWeekdays, tz: config.tz }),
  0,
);

console.log("presence day ok");
