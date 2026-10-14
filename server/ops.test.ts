import assert from "node:assert/strict";
import { DEFAULT_FIGHT_SETTINGS, SHOP_ZONE, zonedParts } from "@shared/fight";
import {
  advanceLevel,
  applyWeekStreak,
  demoOps,
  levelReward,
  markPaid,
  mondayOf,
  ownLoginPct,
  payoutCsv,
  readiness,
  splitPotWithHours,
  suggestMove,
  summarizeWeek,
  weeklyBreakEven,
  type Payout,
} from "@shared/ops";
import { FightBook } from "./fight/book.ts";

let level = 0;
let run = 0;
const events = [];
for (let day = 0; day < 5; day++) {
  const next = advanceLevel({ level, consecutive: run, rules: { clearsInARow: 5, table: [{ level: 1, payBumpCents: 50, potBonusBps: 0 }] }, cleared: true });
  level = next.level;
  run = next.consecutive;
  if (next.event) events.push(next.event);
}
assert.equal(level, 1);
assert.equal(run, 5);
assert.equal(events.length, 1);
assert.equal(events[0]?.reason, "5 open days cleared");

const sixth = advanceLevel({
  level,
  consecutive: run,
  rules: { clearsInARow: 5, table: [{ level: 1, payBumpCents: 50, potBonusBps: 0 }, { level: 2, payBumpCents: 100, potBonusBps: 250 }] },
  cleared: true,
});
assert.equal(sixth.level, 1);
assert.equal(sixth.consecutive, 6);
assert.equal(sixth.event, null);

const missed = advanceLevel({ level: sixth.level, consecutive: sixth.consecutive, rules: { clearsInARow: 5, table: [{ level: 1, payBumpCents: 50, potBonusBps: 0 }] }, cleared: false });
assert.equal(missed.level, 1);
assert.equal(missed.consecutive, 0);
assert.equal(levelReward(1, { clearsInARow: 5, table: [{ level: 1, payBumpCents: 50, potBonusBps: 0 }, { level: 2, payBumpCents: 100, potBonusBps: 250 }] }).payBumpCents, 50);
assert.equal(levelReward(2, { clearsInARow: 5, table: [{ level: 1, payBumpCents: 50, potBonusBps: 0 }, { level: 2, payBumpCents: 100, potBonusBps: 250 }] }).potBonusBps, 250);
assert.equal(levelReward(0, { clearsInARow: 5, table: [{ level: 1, payBumpCents: 50, potBonusBps: 0 }] }).payBumpCents, 0);

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
assert.equal(week.potCents, 2_146);
assert.equal(week.shares.reduce((sum, row) => sum + row.cents, 0), 2_146);
assert.deepEqual(week.shares.map((row) => row.cents), [1_073, 1_073]);

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
assert.deepEqual(splitPotWithHours(10, [{ id: "a", name: "A", ms: 2 }, { id: "b", name: "B", ms: 1 }]).map((row) => row.cents), [7, 3]);
assert.equal(splitPotWithHours(0, [{ id: "a", name: "A", ms: hour }])[0]?.cents, 0);

const scope = { companyId: "shop", locationId: "local" };
const payout: Payout = {
  ...scope,
  weekStart: "2026-10-05",
  potCents: 8_500,
  shares: [
    { id: "ada", name: "Ada", cents: 4_250, ms: 5 * hour },
    { id: "ben", name: "Ben, Jr", cents: 4_250, ms: 5 * hour },
  ],
  status: "open",
  approvedAt: null,
};
const other: Payout = { ...payout, companyId: "other", weekStart: "2026-10-05", potCents: 1 };
const paid = markPaid([payout, other], scope, "2026-10-05", 50);
assert.equal(paid[0]?.status, "paid");
assert.equal(paid[0]?.potCents, 8_500);
assert.equal(paid[0]?.approvedAt, 50);
assert.equal(paid[1]?.status, "open");
assert.equal(markPaid(paid, scope, "2026-10-05", 90), paid);
assert.throws(() => markPaid(paid, scope, "2026-10-12", 90), /not closed/);
const csv = payoutCsv(paid.filter((row) => row.companyId === "shop"));
assert.equal(csv.includes("Ada"), true);
assert.equal(csv.includes("\"Ben, Jr\""), true);
assert.equal(csv.includes("42.50"), true);
assert.equal(csv.includes("paid"), true);
assert.equal(csv.includes("other"), false);

assert.equal(suggestMove({ hour: 14, collectedCents: 1_000, breakEvenCents: 39_265, invoices: [] }), null);
assert.equal(
  suggestMove({
    hour: 16,
    collectedCents: 24_000,
    breakEvenCents: 39_265,
    invoices: [{ id: "inv", title: "Booth", status: "UNPAID", dueCents: 42_000, quote: false, teamMemberId: null }],
  }),
  "Tip: chase Booth invoice $420",
);
assert.equal(
  suggestMove({
    hour: 16,
    collectedCents: 24_000,
    breakEvenCents: 39_265,
    invoices: [{ id: "q", title: "Patio", status: "DRAFT", dueCents: 0, quote: true, teamMemberId: null }],
  }),
  "Tip: follow up on the Patio quote",
);
assert.equal(suggestMove({ hour: 16, collectedCents: 200_000, breakEvenCents: 39_265, invoices: [] }), null);
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
    { level: 1, payBumpCents: 50, potBonusBps: 0 },
    { level: 2, payBumpCents: 100, potBonusBps: 250 },
  ],
});
const thursday = atChicago("2026-10-15", 16);
book.addHours("ada", "Ada", 5 * hour, { now: thursday, lifetimeCollected: 0, lifetimeSettled: 0 });
book.replaceInvoices([{ id: "inv", title: "Booth", status: "UNPAID", dueCents: 42_000, quote: false, teamMemberId: "ada" }]);
book.sync({ now: thursday, lifetimeCollected: 24_000, lifetimeSettled: 18_000, saleCents: 24_000, ...quiet });
assert.equal(book.opsView().nudge, "Tip: chase Booth invoice $420");
book.sync({ now: thursday, lifetimeCollected: 50_000, lifetimeSettled: 18_000, saleCents: 26_000, ...quiet });
assert.equal(book.opsView().level, 0);
assert.equal(book.opsView().nudge, null);

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
assert.equal(book.opsView().payBumpCents, 50);

const tuesday = atChicago("2026-10-20", 12);
const after = book.sync({ now: tuesday, lifetimeCollected: 100_000, lifetimeSettled: 36_000, ...quiet });
assert.equal(after.streak, 1);
assert.equal(book.opsView().consecutiveClears, 0);
const closed = book.opsView().payout;
assert.ok(closed);
assert.equal(closed?.weekStart, "2026-10-12");
assert.equal(closed?.potCents, 2_146);
assert.equal(closed?.status, "open");
assert.equal(closed?.shares.reduce((sum, row) => sum + row.cents, 0), 2_146);
assert.equal(book.opsView().weekStreak, 0);

const approved = book.approvePayout("2026-10-12", 80);
assert.equal(approved.status, "paid");
assert.equal(approved.potCents, 2_146);
assert.equal(book.approvePayout("2026-10-12", 90).approvedAt, 80);
assert.equal(book.payoutCsv().includes("Ada"), true);
assert.equal(book.payoutCsv().includes("paid"), true);
assert.throws(() => book.approvePayout("2026-09-28", 90), /not closed/);
assert.equal(JSON.stringify(book.toPersist()).includes("scrypt$"), false);
assert.equal(demoOps("morning").nudge, "Tip: chase Booth invoice $420");
assert.equal(demoOps("cleared").nudge, null);

console.log("ops ok");
