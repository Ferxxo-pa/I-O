import assert from "node:assert/strict";
import { SHOP_ZONE, potCents, zonedParts } from "@shared/fight";
import {
  CUSHION_MAX_CENTS,
  SALE_CAP_CENTS,
  closeWeek,
  copyLine,
  cushionTotal,
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
