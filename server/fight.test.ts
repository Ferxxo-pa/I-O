import assert from "node:assert/strict";
import {
  DEFAULT_FIGHT_SETTINGS,
  SHOP_ZONE,
  applyStreak,
  breakEvenCents,
  demoModel,
  fightSettingsSchema,
  hitTier,
  notchPercent,
  openDaysInMonth,
  openDaysStrictlyBetween,
  potCents,
  saleTapeLabel,
  splitPot,
  startOfZonedDay,
  zonedParts,
} from "@shared/fight";
import { hashPin, pinLocked, resetPinAttempts, verifyPin, assertShopPin } from "./auth/pin.ts";
import { FightBook } from "./fight/book.ts";

assert.equal(
  breakEvenCents({
    wagesCents: 18_000,
    monthlyFixedCents: 290_000,
    openDays: 22,
    materialsBps: 1_300,
    feeBps: 300,
  }),
  39_265,
);

assert.throws(() =>
  breakEvenCents({
    wagesCents: 0,
    monthlyFixedCents: 100,
    openDays: 1,
    materialsBps: 6_000,
    feeBps: 4_000,
  }),
);

assert.equal(openDaysInMonth(2026, 10, [1, 2, 3, 4, 5]), 22);
assert.equal(potCents(164_000, 78_550, 1_000), 8_545);
assert.deepEqual(
  splitPot(10, [
    { id: "a", name: "A", ms: 2 },
    { id: "b", name: "B", ms: 1 },
  ]).map((row) => row.cents),
  [7, 3],
);
const even = splitPot(100, [
  { id: "a", name: "A", ms: 1 },
  { id: "b", name: "B", ms: 1 },
]);
assert.equal(even.reduce((sum, row) => sum + row.cents, 0), 100);

let streak = 0;
streak = applyStreak(streak, true);
streak = applyStreak(streak, true);
streak = applyStreak(streak, true);
streak = applyStreak(streak, false);
assert.equal(streak, 2);
assert.equal(applyStreak(0, false), 0);

assert.equal(hitTier(9_999), "small");
assert.equal(hitTier(10_000), "solid");
assert.equal(hitTier(49_999), "solid");
assert.equal(hitTier(50_000), "big");
assert.equal(hitTier(199_999), "big");
assert.equal(hitTier(200_000), "crit");
assert.equal(saleTapeLabel(20_000), "+$200");
assert.equal(saleTapeLabel(240_000), "+$2,400 CRIT");

assert.equal(
  fightSettingsSchema.safeParse({ ...DEFAULT_FIGHT_SETTINGS, materialsBps: 8_000, feeBps: 3_000 }).success,
  false,
);

function atChicago(key: string, hour: number): number {
  const [year, month, day] = key.split("-").map(Number);
  for (let utcHour = 0; utcHour < 30; utcHour++) {
    const time = Date.UTC(year, month - 1, day, utcHour, 30, 0);
    const parts = zonedParts(time, SHOP_ZONE);
    if (parts.key === key && parts.hour === hour) return time;
  }
  throw new Error(`no Austin instant for ${key} ${hour}`);
}

const noon = atChicago("2026-10-14", 12);
assert.equal(zonedParts(noon).weekday, 3);
const start = startOfZonedDay(noon);
assert.equal(zonedParts(start).key, "2026-10-14");
assert.notEqual(zonedParts(start - 1).key, "2026-10-14");
assert.equal(openDaysStrictlyBetween("2026-10-16", "2026-10-20", [1, 2, 3, 4, 5]), 1);

const morning = demoModel("morning");
assert.equal(morning.clockedIn, true);
assert.equal(morning.view.cleared, false);
assert.ok(morning.view.toBreakEvenCents > 0);
const green =
  morning.view.todayCollectedCents / (morning.view.todayCollectedCents + morning.view.todayWageCents);
assert.ok(morning.view.notchPct > green * 100);
assert.equal(morning.view.breakEvenCents, 39_265);

const crit = demoModel("crit");
assert.equal(crit.hitCents, 240_000);
assert.equal(hitTier(crit.hitCents), "crit");
assert.equal(crit.view.cleared, false);
assert.ok(crit.view.toBreakEvenCents > 0);
assert.equal(notchPercent(crit.view.breakEvenCents, crit.view.todayWageCents), crit.view.notchPct);

const cleared = demoModel("cleared");
assert.equal(cleared.view.cleared, true);
assert.equal(cleared.view.potCents, 8_545);
assert.equal(
  cleared.view.shares.reduce((sum, row) => sum + row.cents, 0),
  cleared.view.potCents,
);
assert.deepEqual(
  cleared.view.shares.map((row) => row.name),
  ["Ada", "Ben", "Sol"],
);
assert.ok(cleared.view.shares[0].cents > cleared.view.shares[1].cents);
assert.ok(cleared.view.shares[1].cents > cleared.view.shares[2].cents);

const idle = demoModel("idle");
assert.equal(idle.clockedIn, false);
assert.equal(idle.view.cleared, false);
assert.equal(idle.view.todayCollectedCents, morning.view.todayCollectedCents);

const quiet = { accrualSince: () => 0, liveHoursSince: () => [] };
const book = new FightBook();
const thursday = atChicago("2026-10-15", 15);
book.sync({ now: thursday, lifetimeCollected: 0, lifetimeSettled: 0, ...quiet });
const clearedThursday = book.sync({
  now: thursday,
  lifetimeCollected: 50_000,
  lifetimeSettled: 18_000,
  saleCents: 50_000,
  ...quiet,
});
assert.equal(clearedThursday.cleared, true);
assert.equal(clearedThursday.streak, 1);

const friday = atChicago("2026-10-16", 15);
book.sync({ now: friday, lifetimeCollected: 50_000, lifetimeSettled: 18_000, ...quiet });
const clearedFriday = book.sync({
  now: friday,
  lifetimeCollected: 100_000,
  lifetimeSettled: 36_000,
  saleCents: 50_000,
  ...quiet,
});
assert.equal(clearedFriday.streak, 2);
assert.equal(clearedFriday.cleared, true);

const tuesday = atChicago("2026-10-20", 15);
const afterMiss = book.sync({
  now: tuesday,
  lifetimeCollected: 100_000,
  lifetimeSettled: 36_000,
  ...quiet,
});
assert.equal(afterMiss.streak, 1);
assert.equal(afterMiss.cleared, false);

const pin = "2468";
const hashed = hashPin(pin);
assert.equal(verifyPin(pin, hashed), true);
assert.equal(verifyPin("2469", hashed), false);
assert.equal(hashed.includes(pin), false);
assert.ok(hashed.startsWith("scrypt$"));

const potBook = new FightBook();
potBook.setPin(pin);
const wednesday = atChicago("2026-10-14", 11);
const hour = 3_600_000;
potBook.sync({ now: wednesday, lifetimeCollected: 0, lifetimeSettled: 0, accrualSince: () => 48_000, liveHoursSince: () => [] });
for (const [id, name, hours] of [
  ["ada", "Ada", 5],
  ["ben", "Ben", 3],
  ["sol", "Sol", 2],
] as const) {
  potBook.addHours(id, name, hours * hour, {
    now: wednesday,
    lifetimeCollected: 0,
    lifetimeSettled: 0,
  });
}
const pot = potBook.sync({
  now: wednesday,
  lifetimeCollected: 164_000,
  lifetimeSettled: 0,
  saleCents: 164_000,
  accrualSince: () => 48_000,
  liveHoursSince: () => [],
});
assert.equal(pot.cleared, true);
assert.equal(pot.potCents, 8_545);
assert.equal(pot.shares.reduce((sum, row) => sum + row.cents, 0), pot.potCents);
assert.equal(pot.pinSet, true);
assert.equal(JSON.stringify(pot).includes(pin), false);
assert.equal(JSON.stringify(potBook.toPersist()).includes(pin), false);

resetPinAttempts();
let locked = false;
for (let i = 0; i < 6; i++) {
  try {
    assertShopPin("0000", "test-ip", true, () => false);
  } catch (err) {
    locked = err instanceof Error && err.message === "Too many tries";
  }
}
assert.equal(locked, true);
assert.equal(pinLocked("test-ip"), true);
resetPinAttempts();

console.log("fight ok");
