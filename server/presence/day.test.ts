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
const customDays = dayConfigFromEnv({ PRESENCE_OPEN_WEEKDAYS: "0, 6," });
assert.deepEqual(customDays.openWeekdays, [0, 6]);

console.log("presence day ok");
