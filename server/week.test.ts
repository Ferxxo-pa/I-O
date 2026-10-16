import assert from "node:assert/strict";
import { SHOP_ZONE, potCents, zonedParts } from "@shared/fight";
import {
  CUSHION_MAX_CENTS,
  SALE_CAP_CENTS,
  closeWeek,
  copyLine,
  cushionTotal,
  consecutiveWorkedDays,
  formatWorkStreak,
  streakMark,
  halfTargetCents,
  menuLevel,
  menuWorkLine,
  shownWorkedDays,
  weekFillPct,
  demoWeek,
  depositCushion,
  drawCushion,
  expireLots,
  netOfSale,
  splitSale,
  summarizeWeekBar,
  weekBarTarget,
  weekMonday,
} from "@shared/week";
import { FightBook } from "./fight/book.ts";

const OPEN = [1, 2, 3, 4, 5];

assert.equal(
  weekBarTarget({
    weeklyTargetCents: 290_000,
    materialsBps: 1_300,
    feeBps: 300,
    rentMonthlyCents: 0,
    rentEntered: false,
    weekOpenDays: 5,
    monthOpenDays: 22,
  }),
  243_600,
);

assert.equal(
  weekBarTarget({
    weeklyTargetCents: 290_000,
    materialsBps: 1_300,
    feeBps: 300,
    rentMonthlyCents: 100_000,
    rentEntered: false,
    weekOpenDays: 5,
    monthOpenDays: 22,
  }),
  243_600 + Math.round((100_000 * 5) / 22),
);

assert.equal(
  weekBarTarget({
    weeklyTargetCents: 290_000,
    materialsBps: 1_300,
    feeBps: 300,
    rentMonthlyCents: 100_000,
    rentEntered: true,
    weekOpenDays: 5,
    monthOpenDays: 22,
  }),
  243_600,
);

assert.equal(netOfSale(100_000, null, 1_300, 300), 84_000);
assert.equal(netOfSale(100_000, 20_000, 1_300, 300), 77_000);
assert.equal(netOfSale(250_000, null, 1_300, 300), 210_000);

const capped = splitSale(210_000);
assert.equal(capped.barCents, SALE_CAP_CENTS);
assert.equal(capped.bankCents, 210_000 - SALE_CAP_CENTS);
assert.deepEqual(splitSale(50_000), { barCents: 50_000, bankCents: 0 });

const banked = depositCushion([{ cents: 250_000, earnedMonday: "2026-09-07" }], 80_000, "2026-10-12");
assert.equal(cushionTotal(banked), CUSHION_MAX_CENTS);

const fresh = expireLots(
  [
    { cents: 10_000, earnedMonday: "2026-09-14" },
    { cents: 20_000, earnedMonday: "2026-09-21" },
  ],
  "2026-10-05",
);
assert.equal(cushionTotal(fresh), 30_000);
const aged = expireLots(fresh, "2026-10-12");
assert.deepEqual(aged, [{ cents: 20_000, earnedMonday: "2026-09-21" }]);
assert.equal(cushionTotal(expireLots(aged, "2026-10-19")), 0);

const drawn = drawCushion(
  [
    { cents: 5_000, earnedMonday: "2026-09-28" },
    { cents: 8_000, earnedMonday: "2026-10-05" },
  ],
  6_000,
  100_000,
);
assert.equal(drawn.used, 6_000);
assert.deepEqual(drawn.lots, [{ cents: 7_000, earnedMonday: "2026-10-05" }]);

const target = 243_600;
const half = Math.floor(target / 2);
const base = {
  today: "2026-10-14",
  weeksCovered: 0,
  weeklyTargetCents: 290_000,
  materialsBps: 1_300,
  feeBps: 300,
  rentMonthlyCents: 0,
  rentEntered: false,
  openWeekdays: OPEN,
  monthOpenDays: 22,
};

const under = summarizeWeekBar({
  ...base,
  ownCents: half - 1,
  lots: [{ cents: 500_000, earnedMonday: "2026-10-05" }],
});
assert.equal(under.cushionUsedCents, half);
assert.equal(under.covered, false);
assert.notEqual(under.state, "covered");

const clearedByCushion = summarizeWeekBar({
  ...base,
  ownCents: half,
  lots: [{ cents: target, earnedMonday: "2026-10-05" }],
});
assert.equal(clearedByCushion.covered, true);
assert.equal(clearedByCushion.cushionUsedCents, target - half);
assert.equal(clearedByCushion.state, "covered");

const halfAlone = summarizeWeekBar({ ...base, ownCents: half, lots: [] });
assert.equal(halfAlone.covered, false);
assert.equal(halfAlone.state, "hump");

const whale = summarizeWeekBar({ ...base, ownCents: 389_760, lots: [] });
assert.equal(whale.shownPct, 1.5);
assert.equal(whale.barPct, 1);
assert.equal(whale.overCents, 389_760 - target);
assert.equal(whale.covered, true);

const closed = closeWeek({
  weekStart: "2026-10-12",
  ownCents: 200_000,
  lots: [{ cents: 100_000, earnedMonday: "2026-09-28" }],
  targetCents: target,
  weeksCovered: 2,
});
assert.equal(closed.covered, true);
assert.equal(closed.weeksCovered, 3);
assert.equal(closed.weekStart, "2026-10-19");
assert.equal(cushionTotal(closed.lots), 100_000 - (target - 200_000));

const missed = closeWeek({
  weekStart: "2026-10-12",
  ownCents: 50_000,
  lots: [{ cents: 200_000, earnedMonday: "2026-09-28" }],
  targetCents: target,
  weeksCovered: 4,
});
assert.equal(missed.covered, false);
assert.equal(missed.weeksCovered, 0);
assert.equal(cushionTotal(missed.lots), 200_000 - half);

const expiredOnRoll = closeWeek({
  weekStart: "2026-11-02",
  ownCents: target,
  lots: [{ cents: 40_000, earnedMonday: "2026-10-12" }],
  targetCents: target,
  weeksCovered: 0,
});
assert.equal(expiredOnRoll.covered, true);
assert.equal(expiredOnRoll.weekStart, "2026-11-09");
assert.equal(cushionTotal(expiredOnRoll.lots), 0);

for (const preset of ["low", "mid", "stretch", "covered", "cushion"] as const) {
  const view = demoWeek(preset);
  assert.equal(view.lines.length, 3);
  assert.equal(new Set(view.lines).size, 3);
  for (const line of view.lines) assert.ok(line.length <= 20, `${preset}: ${line}`);
}
assert.equal(copyLine(demoWeek("low"), 0), "$800 so far");
assert.equal(copyLine(demoWeek("mid"), 0), "34% to cover");
assert.equal(copyLine(demoWeek("mid"), 1), "Over the hump");
assert.equal(copyLine(demoWeek("stretch"), 0), "One sale away");
assert.equal(copyLine(demoWeek("covered"), 0), "Covered. Now profit.");
assert.equal(copyLine(demoWeek("covered"), 1), "In the green");
const lowWeek = demoWeek("low");
const midWeek = demoWeek("mid");
const coveredWeek = demoWeek("covered");
const halfCut = halfTargetCents(lowWeek.targetCents);
assert.equal(halfCut, Math.floor(lowWeek.targetCents / 2));
assert.equal(lowWeek.targetCents, weekBarTarget({
  weeklyTargetCents: 290_000,
  materialsBps: 1_300,
  feeBps: 300,
  rentMonthlyCents: 0,
  rentEntered: false,
  weekOpenDays: 5,
  monthOpenDays: 22,
}));
assert.equal(menuWorkLine(false, halfCut - 1, lowWeek.targetCents), "Hardly working");
assert.equal(menuWorkLine(false, halfCut, lowWeek.targetCents), "Working hard");
assert.equal(menuWorkLine(true, lowWeek.targetCents, lowWeek.targetCents), "Working harder");
assert.equal(menuWorkLine(lowWeek.covered, lowWeek.ownCents + lowWeek.cushionUsedCents, lowWeek.targetCents), "Hardly working");
assert.equal(menuWorkLine(midWeek.covered, midWeek.ownCents + midWeek.cushionUsedCents, midWeek.targetCents), "Working hard");
assert.equal(menuWorkLine(coveredWeek.covered, coveredWeek.ownCents + coveredWeek.cushionUsedCents, coveredWeek.targetCents), "Working harder");
const cushionWeek = demoWeek("cushion");
assert.equal(
  menuWorkLine(cushionWeek.covered, cushionWeek.ownCents + cushionWeek.cushionUsedCents, cushionWeek.targetCents),
  "Working hard",
);
const lowFilled = lowWeek.ownCents + lowWeek.cushionUsedCents;
const lowLevel = menuLevel({
  weeksCovered: lowWeek.weeksCovered,
  filledCents: lowFilled,
  targetCents: lowWeek.targetCents,
  covered: lowWeek.covered,
});
assert.equal(lowLevel.level, 1);
assert.equal(lowLevel.next, 2);
assert.equal(lowLevel.pct, weekFillPct(lowFilled, lowWeek.targetCents, lowWeek.covered));
assert.ok(lowLevel.pct < 50);
const coveredLevel = menuLevel({
  weeksCovered: coveredWeek.weeksCovered,
  filledCents: coveredWeek.ownCents + coveredWeek.cushionUsedCents,
  targetCents: coveredWeek.targetCents,
  covered: coveredWeek.covered,
});
assert.equal(coveredLevel.level, 2);
assert.equal(coveredLevel.next, 3);
assert.equal(coveredLevel.pct, 100);
assert.equal(menuLevel({ weeksCovered: 1, filledCents: 1, targetCents: 4, covered: false }).level, 1);
assert.equal(menuLevel({ weeksCovered: 3, filledCents: 1, targetCents: 4, covered: false }).level, 2);
assert.equal(menuLevel({ weeksCovered: 4, filledCents: 1, targetCents: 4, covered: false }).level, 3);
assert.equal(menuLevel({ weeksCovered: 8, filledCents: 1, targetCents: 4, covered: false }).level, 4);
assert.equal(menuLevel({ weeksCovered: 13, filledCents: 1, targetCents: 4, covered: false }).level, 5);
assert.equal(menuLevel({ weeksCovered: 25, filledCents: 1, targetCents: 4, covered: false }).level, 5);
const top = menuLevel({ weeksCovered: 26, filledCents: 1, targetCents: 4, covered: false });
assert.equal(top.level, 6);
assert.equal(top.next, null);
assert.equal(top.pct, 25);
assert.equal(formatWorkStreak(0), "0 days");
assert.equal(formatWorkStreak(1), "1 day");
assert.equal(formatWorkStreak(6), "6 days");
assert.equal(formatWorkStreak(7), "1 week");
assert.equal(formatWorkStreak(8), "1 week, 1 day");
assert.equal(formatWorkStreak(10), "1 week, 3 days");
assert.equal(formatWorkStreak(14), "2 weeks");
assert.equal(formatWorkStreak(15), "2 weeks, 1 day");
assert.deepEqual(streakMark(0), { count: 0, label: "day streak" });
assert.deepEqual(streakMark(1), { count: 1, label: "day streak" });
assert.deepEqual(streakMark(6), { count: 6, label: "day streak" });
assert.deepEqual(streakMark(7), { count: 7, label: "1 week" });
assert.deepEqual(streakMark(10), { count: 10, label: "1 week, 3 days" });
assert.deepEqual(streakMark(14), { count: 14, label: "2 weeks" });
const open = [1, 2, 3, 4, 5];
const run = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"];
assert.equal(
  consecutiveWorkedDays({
    today: "2026-10-14",
    openWeekdays: open,
    days: run.map((date) => ({ date, worked: true })),
    todayWorked: true,
  }),
  10,
);
assert.equal(
  consecutiveWorkedDays({
    today: "2026-10-14",
    openWeekdays: open,
    days: run.map((date) => ({ date, worked: true })),
    todayWorked: false,
  }),
  9,
);
assert.equal(
  consecutiveWorkedDays({
    today: "2026-10-14",
    openWeekdays: open,
    days: [
      { date: "2026-10-13", worked: true },
      { date: "2026-10-12", worked: false },
      { date: "2026-10-09", worked: true },
    ],
    todayWorked: false,
  }),
  1,
);
assert.equal(
  consecutiveWorkedDays({
    today: "2026-10-14",
    openWeekdays: open,
    days: [{ date: "2026-10-13", worked: false }, { date: "2026-10-09", worked: true }],
    todayWorked: false,
  }),
  0,
);
assert.equal(shownWorkedDays(9, false, true, true), 10);
assert.equal(shownWorkedDays(9, true, true, true), 9);
assert.equal(shownWorkedDays(9, false, false, true), 9);
assert.equal(shownWorkedDays(9, false, true, false), 9);
const cushion = demoWeek("cushion");
assert.equal(cushion.covered, false);
assert.equal(cushion.bankedCents, 120_000);
assert.equal(cushion.expiresInWeeks, 2);
assert.equal(cushion.cushionUsedCents, 120_000);
assert.equal(cushion.ownCents, 80_000);
assert.equal(weekMonday("2026-10-18"), "2026-10-12");
assert.equal(weekMonday("2026-10-12"), "2026-10-12");

function atChicago(key: string, hour: number): number {
  const [year, month, day] = key.split("-").map(Number);
  for (let utcHour = 0; utcHour < 30; utcHour++) {
    const time = Date.UTC(year, month - 1, day, utcHour, 30, 0);
    const parts = zonedParts(time, SHOP_ZONE);
    if (parts.key === key && parts.hour === hour) return time;
  }
  throw new Error(`no chicago instant for ${key} ${hour}`);
}

const book = new FightBook();
const quiet = { accrualSince: () => 0, liveHoursSince: () => [] as [] };
const sunday = atChicago("2026-10-11", 16);
const monday = atChicago("2026-10-12", 10);
book.sync({
  now: monday,
  lifetimeCollected: 250_000,
  lifetimeSettled: 0,
  saleCents: 250_000,
  weekSale: { id: "whale", grossCents: 250_000, paidAt: sunday, materialsCents: null },
  ...quiet,
});
const afterWhale = book.sync({
  now: monday,
  lifetimeCollected: 250_000,
  lifetimeSettled: 0,
  weekSale: { id: "whale", grossCents: 250_000, paidAt: sunday, materialsCents: null },
  ...quiet,
});
assert.equal(afterWhale.todayWageCents, 0);
assert.equal(afterWhale.todayCollectedCents, 250_000);
assert.equal(afterWhale.week.ownCents, 0);
assert.equal(afterWhale.week.weeksCovered, 0);
assert.equal(afterWhale.week.bankedCents, 210_000 - SALE_CAP_CENTS - half);
assert.equal(potCents(250_000, afterWhale.breakEvenCents, afterWhale.settings.potBps), afterWhale.potCents);

let gross = 0;
for (let n = 0; n < 3; n++) {
  gross += 120_000;
  const when = atChicago("2026-10-14", 11);
  book.sync({
    now: when,
    lifetimeCollected: 250_000 + gross,
    lifetimeSettled: 0,
    saleCents: 120_000,
    weekSale: { id: `job-${n}`, grossCents: 120_000, paidAt: when, materialsCents: null },
    ...quiet,
  });
}
const midweek = book.sync({
  now: atChicago("2026-10-14", 12),
  lifetimeCollected: 250_000 + gross,
  lifetimeSettled: 0,
  ...quiet,
});
assert.equal(midweek.todayWageCents, 0);
assert.equal(midweek.week.ownCents, SALE_CAP_CENTS * 3);
assert.equal(midweek.week.covered, true);

const next = book.sync({
  now: atChicago("2026-10-19", 9),
  lifetimeCollected: 250_000 + gross,
  lifetimeSettled: 0,
  ...quiet,
});
assert.equal(next.week.weekStart, "2026-10-19");
assert.equal(next.week.ownCents, 0);
assert.equal(next.week.weeksCovered, 1);
assert.equal(next.todayWageCents, 0);

const later = book.sync({
  now: atChicago("2026-11-09", 9),
  lifetimeCollected: 250_000 + gross,
  lifetimeSettled: 0,
  ...quiet,
});
assert.equal(later.week.bankedCents, 0);
assert.equal(later.todayWageCents, 0);

const streakBook = new FightBook();
const workedKeys = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"];
for (const key of workedKeys) {
  const now = atChicago(key, 11);
  streakBook.sync({ now, lifetimeCollected: 0, lifetimeSettled: 0, ...quiet });
  streakBook.addHours("ada", "Ada", 3_600_000, { now, lifetimeCollected: 0, lifetimeSettled: 0 });
}
const quietToday = streakBook.sync({
  now: atChicago("2026-10-14", 10),
  lifetimeCollected: 0,
  lifetimeSettled: 0,
  ...quiet,
});
assert.equal(quietToday.todayWorked, false);
assert.equal(quietToday.workedDays, 9);
assert.equal(formatWorkStreak(shownWorkedDays(quietToday.workedDays, quietToday.todayWorked, true, true)), "1 week, 3 days");
const clockedToday = streakBook.sync({
  now: atChicago("2026-10-14", 11),
  lifetimeCollected: 0,
  lifetimeSettled: 0,
  accrualSince: () => 0,
  liveHoursSince: () => [{ personId: "ada", name: "Ada", ms: 1_000 }],
});
assert.equal(clockedToday.todayWorked, true);
assert.equal(clockedToday.workedDays, 10);
assert.equal(formatWorkStreak(clockedToday.workedDays), "1 week, 3 days");
