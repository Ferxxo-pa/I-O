import assert from "node:assert/strict";
import { DEFAULT_FIGHT_SETTINGS, SHOP_ZONE, zonedParts } from "@shared/fight";
import {
  DEFAULT_LEVEL_RULES,
  advanceLevel,
  applyWeekStreak,
  buildWeekPips,
  demoOps,
  levelProgress,
  levelUnlockLine,
  mondayOf,
  ownLoginPct,
  readiness,
  summarizeWeek,
  unlockName,
  weeklyBreakEven,
  weekWonFriday,
} from "@shared/ops";
import { FightBook } from "./fight/book.ts";

let level = 0;
let run = 0;
const events = [];
for (let day = 0; day < 5; day++) {
  const next = advanceLevel({ level, consecutive: run, rules: { clearsInARow: 5, table: [{ level: 2, reward: "team lunch" }] }, cleared: true });
  level = next.level;
  run = next.consecutive;
  if (next.event) events.push(next.event);
}
assert.equal(level, 1);
assert.equal(levelUnlockLine(1, 3, DEFAULT_LEVEL_RULES), "Lv 1 · team lunch in 2 days");
assert.deepEqual(levelProgress(1, 3, 5), { level: 1, next: 2, pct: 60 });
assert.deepEqual(levelProgress(3, 0, 5), { level: 3, next: 4, pct: 0 });
assert.equal(levelProgress(3, 5, 5).pct, 0);
assert.equal(levelUnlockLine(1, 4, DEFAULT_LEVEL_RULES), "Lv 1 · team lunch in 1 day");
assert.equal(levelUnlockLine(2, 5, DEFAULT_LEVEL_RULES), "Lv 2 · team playlist pick in 5 days");
assert.equal(unlockName(2, DEFAULT_LEVEL_RULES), "team lunch");
assert.equal(unlockName(4, DEFAULT_LEVEL_RULES), "early close on a won Friday");
assert.equal(unlockName(9, DEFAULT_LEVEL_RULES), null);
assert.equal(
  levelUnlockLine(9, 0, { clearsInARow: 5, table: [{ level: 2, reward: "team lunch" }] }),
  "Lv 9 · 5 days to Lv 10",
);
assert.equal(weekWonFriday("2026-10-16", true), true);
assert.equal(weekWonFriday("2026-10-14", true), false);
assert.equal(weekWonFriday("2026-10-16", false), false);
assert.equal(run, 5);
assert.equal(events.length, 1);
assert.equal(events[0]?.reason, "5 open days cleared");

const sixth = advanceLevel({
  level,
  consecutive: run,
  rules: { clearsInARow: 5, table: [{ level: 2, reward: "team lunch" }, { level: 3, reward: "team playlist pick" }] },
  cleared: true,
});
assert.equal(sixth.level, 1);
assert.equal(sixth.consecutive, 6);
assert.equal(sixth.event, null);

const missed = advanceLevel({ level: sixth.level, consecutive: sixth.consecutive, rules: { clearsInARow: 5, table: [{ level: 2, reward: "team lunch" }] }, cleared: false });
assert.equal(missed.level, 1);
assert.equal(missed.consecutive, 0);

assert.equal(weeklyBreakEven({
  wagesCents: 36_000,
  monthlyFixedCents: 290_000,
  monthOpenDays: 22,
  weekOpenDays: 5,
  materialsBps: 1_300,
  feeBps: 300,
}), 125_608);
assert.equal(mondayOf("2026-10-16"), "2026-10-12");
assert.equal(applyWeekStreak(2, true), 3);
assert.equal(applyWeekStreak(0, false), 0);

const hour = 3_600_000;
const week = summarizeWeek(
  "2026-10-12",
  [
    {
      date: "2026-10-15",
      collectedCents: 50_000,
      wageCents: 18_000,
      potCents: 1_073,
      payoutPotCents: 1_073,
      hours: [{ id: "ada", name: "Ada", ms: 5 * hour }],
    },
    {
      date: "2026-10-16",
      collectedCents: 50_000,
      wageCents: 18_000,
      potCents: 1_073,
      payoutPotCents: 1_073,
      hours: [{ id: "ben", name: "Ben", ms: 5 * hour }],
    },
  ],
  DEFAULT_FIGHT_SETTINGS,
);
assert.equal(week.collectedCents, 100_000);
assert.equal(week.breakEvenCents, 125_608);
assert.equal(week.cleared, false);
assert.equal("potCents" in week, false);
assert.equal("shares" in week, false);

const ahead = summarizeWeek(
  "2026-10-12",
  [
    {
      date: "2026-10-16",
      collectedCents: 200_000,
      wageCents: 36_000,
      potCents: 8_000,
      payoutPotCents: 8_000,
      hours: [
        { id: "ada", name: "Ada", ms: 2 },
        { id: "ben", name: "Ben", ms: 1 },
      ],
    },
  ],
  DEFAULT_FIGHT_SETTINGS,
);
assert.equal(ahead.cleared, true);
assert.equal(applyWeekStreak(1, ahead.cleared), 2);

const pips = buildWeekPips({
  today: "2026-10-14",
  openWeekdays: DEFAULT_FIGHT_SETTINGS.openWeekdays,
  clearedDates: ["2026-10-12", "2026-10-13"],
  todayCleared: false,
});
assert.equal(pips.length, 7);
assert.deepEqual(
  pips.map((pip) => pip.state),
  ["hit", "hit", "today", "ahead", "ahead", "off", "off"],
);
assert.deepEqual(
  pips.map((pip) => pip.filled),
  [true, true, false, false, false, false, false],
);
assert.equal(pips[2]?.date, "2026-10-14");
const wonPips = buildWeekPips({
  today: "2026-10-14",
  openWeekdays: DEFAULT_FIGHT_SETTINGS.openWeekdays,
  clearedDates: ["2026-10-12", "2026-10-13", "2026-10-14"],
  todayCleared: true,
});
assert.equal(wonPips[2]?.filled, true);
assert.equal(wonPips[2]?.state, "today");
assert.equal(ownLoginPct(3, 2), 67);
assert.equal(ownLoginPct(0, 0), null);

const checks = readiness({
  squareToken: true,
  webhookConfigured: true,
  webhookSeen: false,
  pinSet: true,
  rentEntered: false,
  ratesOk: true,
  rateDetail: "3 of 3",
  ownLoginPct: 67,
  ownLoginDetail: "2 of 3 · 67%",
});
assert.equal(checks.ready, false);
assert.equal(checks.checks.find((row) => row.id === "webhook")?.ok, false);
assert.equal(checks.checks.find((row) => row.id === "login")?.detail, "2 of 3 · 67%");

function atChicago(key: string, hourOfDay: number): number {
  const [year, month, day] = key.split("-").map(Number);
  for (let utcHour = 0; utcHour < 30; utcHour++) {
    const time = Date.UTC(year, month - 1, day, utcHour, 30, 0);
    const parts = zonedParts(time, SHOP_ZONE);
    if (parts.key === key && parts.hour === hourOfDay) return time;
  }
  throw new Error(`no Austin instant for ${key}`);
}

const quiet = { accrualSince: () => 0, liveHoursSince: () => [] as Array<{ personId: string; name: string; ms: number }> };
const book = new FightBook();
book.updateLevelRules({
  clearsInARow: 2,
  table: [
    { level: 1, reward: "team lunch" },
    { level: 2, reward: "team playlist pick" },
  ],
});
const thursday = atChicago("2026-10-15", 16);
book.addHours("ada", "Ada", 5 * hour, { now: thursday, lifetimeCollected: 0, lifetimeSettled: 0 });
book.sync({ now: thursday, lifetimeCollected: 24_000, lifetimeSettled: 18_000, saleCents: 24_000, ...quiet });
assert.equal(book.opsView().pips.length, 7);
assert.equal(book.opsView().pips.find((pip) => pip.date === "2026-10-15")?.state, "today");
assert.equal(book.opsView().pips.find((pip) => pip.date === "2026-10-15")?.filled, false);
book.sync({ now: thursday, lifetimeCollected: 50_000, lifetimeSettled: 18_000, saleCents: 26_000, ...quiet });
assert.equal(book.opsView().level, 0);
assert.equal(book.opsView().pips.find((pip) => pip.date === "2026-10-15")?.filled, true);

const friday = atChicago("2026-10-16", 16);
book.sync({ now: friday, lifetimeCollected: 50_000, lifetimeSettled: 18_000, ...quiet });
book.addHours("ben", "Ben", 5 * hour, { now: friday, lifetimeCollected: 50_000, lifetimeSettled: 18_000 });
const fridayView = book.sync({
  now: friday,
  lifetimeCollected: 100_000,
  lifetimeSettled: 36_000,
  saleCents: 50_000,
  ...quiet,
});
assert.equal(fridayView.streak, 2);
assert.equal(fridayView.potCents, 1_073);
assert.equal(book.opsView().level, 1);
assert.equal(book.opsView().history.length, 1);
assert.equal(unlockName(book.opsView().level, book.opsView().rules), "team lunch");
assert.equal("payout" in book.opsView(), false);
assert.equal("payBumpCents" in book.opsView(), false);
assert.deepEqual(book.opsView().crew, []);

const tuesday = atChicago("2026-10-20", 12);
const after = book.sync({ now: tuesday, lifetimeCollected: 100_000, lifetimeSettled: 36_000, ...quiet });
assert.equal(after.streak, 1);
assert.equal(book.opsView().consecutiveClears, 0);
assert.equal(book.opsView().weekStreak, 0);
assert.equal("potCents" in book.opsView().week, false);
assert.equal(JSON.stringify(book.toPersist()).includes("scrypt$"), false);
assert.equal(JSON.stringify(book.toPersist()).includes("payouts"), false);
assert.equal(demoOps("morning").pips.filter((pip) => pip.filled).length, 2);
assert.equal(demoOps("cleared").pips.find((pip) => pip.state === "today")?.filled, true);
assert.equal("quest" in demoOps("morning"), false);
assert.equal("nudge" in demoOps("morning"), false);
assert.equal("payout" in demoOps("morning"), false);
assert.deepEqual(
  demoOps("morning").crew.map((mate) => mate.in),
  [true, false, false],
);
assert.deepEqual(
  demoOps("cleared").crew.map((mate) => mate.in),
  [true, true, true],
);
assert.deepEqual(
  demoOps("idle").crew.map((mate) => mate.in),
  [false, false, false],
);
assert.equal(JSON.stringify(demoOps("morning").crew).includes("cents"), false);
assert.equal(JSON.stringify(demoOps("morning").crew).includes("ms"), false);

console.log("ops ok");
