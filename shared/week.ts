import { z } from "zod";

/**
 * Weekly money bar, Monday through Sunday.
 * The target starts as the configurable week number (default $2,900),
 * then materials and fees come off, then this week's share of rent is added
 * unless rent is already inside that number.
 * Each sale puts at most $870 of net on the bar. The rest waits in a cushion
 * that can fill at most half the bar and never touches pay.
 */

export const SALE_CAP_CENTS = 87_000;
export const CUSHION_MAX_CENTS = 290_000;
export const MEDIAN_SALE_CENTS = 15_900;
export const CUSHION_LIFE_DAYS = 28;
export const DEFAULT_WEEKLY_TARGET_CENTS = 290_000;

export const cushionLotSchema = z.object({
  cents: z.number().int().positive(),
  earnedMonday: z.string(),
});

export type CushionLot = z.infer<typeof cushionLotSchema>;

export type CopyState = "bank" | "hump" | "stretch" | "covered";

export type WeekView = {
  weekStart: string;
  ownCents: number;
  bankedCents: number;
  expiresInWeeks: number;
  targetCents: number;
  cushionUsedCents: number;
  remainingCents: number;
  overCents: number;
  paceCents: number;
  covered: boolean;
  shownPct: number;
  barPct: number;
  state: CopyState;
  weeksCovered: number;
  lines: string[];
};

export const weekViewSchema = z.object({
  weekStart: z.string(),
  ownCents: z.number().int(),
  bankedCents: z.number().int(),
  expiresInWeeks: z.number().int(),
  targetCents: z.number().int(),
  cushionUsedCents: z.number().int(),
  remainingCents: z.number().int(),
  overCents: z.number().int(),
  paceCents: z.number().int(),
  covered: z.boolean(),
  shownPct: z.number(),
  barPct: z.number(),
  state: z.enum(["bank", "hump", "stretch", "covered"]),
  weeksCovered: z.number().int(),
  lines: z.array(z.string()),
});

export type WeekSale = {
  id: string;
  grossCents: number;
  paidAt: number;
  materialsCents: number | null;
};

export type WeekPreset = "low" | "mid" | "stretch" | "covered" | "cushion";

function weekdayOf(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addDays(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function weekMonday(key: string): string {
  const weekday = weekdayOf(key);
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return addDays(key, delta);
}

export function daysBetween(start: string, end: string): number {
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye, me, de] = end.split("-").map(Number);
  const a = Date.UTC(ys, ms - 1, ds);
  const b = Date.UTC(ye, me - 1, de);
  return Math.round((b - a) / 86_400_000);
}

export function countOpenDays(monday: string, openWeekdays: readonly number[]): number {
  let count = 0;
  for (let i = 0; i < 7; i++) {
    if (openWeekdays.includes(weekdayOf(addDays(monday, i)))) count += 1;
  }
  return count;
}

/** Open days from today through Sunday, including today when the shop is open. */
export function openDaysLeft(today: string, openWeekdays: readonly number[]): number {
  const sunday = addDays(weekMonday(today), 6);
  let count = 0;
  let cursor = today;
  while (cursor <= sunday) {
    if (openWeekdays.includes(weekdayOf(cursor))) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

export function weekBarTarget(input: {
  weeklyTargetCents: number;
  materialsBps: number;
  feeBps: number;
  rentMonthlyCents: number;
  rentEntered: boolean;
  weekOpenDays: number;
  monthOpenDays: number;
}): number {
  const margin = 10_000 - input.materialsBps - input.feeBps;
  const net = margin <= 0 ? 0 : Math.round((Math.max(0, input.weeklyTargetCents) * margin) / 10_000);
  if (input.rentEntered || input.rentMonthlyCents <= 0 || input.weekOpenDays <= 0) return net;
  const share = Math.round((Math.max(0, input.rentMonthlyCents) * input.weekOpenDays) / Math.max(1, input.monthOpenDays));
  return net + Math.max(0, share);
}

/** Net kept on the bar. Real job materials replace the materials percent. Fees still come off. */
export function netOfSale(
  grossCents: number,
  materialsCents: number | null,
  materialsBps: number,
  feeBps: number,
): number {
  const gross = Math.max(0, Math.round(grossCents));
  if (materialsCents != null) {
    const fee = Math.round((gross * Math.max(0, feeBps)) / 10_000);
    return Math.max(0, gross - Math.max(0, Math.round(materialsCents)) - fee);
  }
  const margin = 10_000 - Math.max(0, materialsBps) - Math.max(0, feeBps);
  if (margin <= 0) return 0;
  return Math.max(0, Math.round((gross * margin) / 10_000));
}

export function splitSale(netCents: number): { barCents: number; bankCents: number } {
  const net = Math.max(0, Math.round(netCents));
  const barCents = Math.min(net, SALE_CAP_CENTS);
  return { barCents, bankCents: Math.max(0, net - barCents) };
}

export function cushionTotal(lots: readonly CushionLot[]): number {
  return lots.reduce((sum, lot) => sum + Math.max(0, lot.cents), 0);
}

/** Drop lots whose 4 weeks are over. A lot is gone on the Monday 28 days after it was earned. */
export function expireLots(lots: readonly CushionLot[], monday: string): CushionLot[] {
  return lots
    .filter((lot) => lot.cents > 0 && monday < addDays(lot.earnedMonday, CUSHION_LIFE_DAYS))
    .map((lot) => ({ cents: lot.cents, earnedMonday: lot.earnedMonday }));
}

export function expiresInWeeks(lots: readonly CushionLot[], monday: string): number {
  const live = expireLots(lots, monday);
  if (live.length === 0) return 0;
  const oldest = live.reduce((soon, lot) => (lot.earnedMonday < soon.earnedMonday ? lot : soon));
  const days = daysBetween(monday, addDays(oldest.earnedMonday, CUSHION_LIFE_DAYS));
  return Math.max(0, Math.round(days / 7));
}

/** Oldest lot first. Never more than `cap` and never more than `need`. */
export function drawCushion(
  lots: readonly CushionLot[],
  need: number,
  cap: number,
): { used: number; lots: CushionLot[] } {
  const ordered = [...lots].sort(
    (a, b) => a.earnedMonday.localeCompare(b.earnedMonday) || a.cents - b.cents,
  );
  let left = Math.max(0, Math.min(need, cap, cushionTotal(ordered)));
  const used = left;
  const next: CushionLot[] = [];
  for (const lot of ordered) {
    if (left <= 0) {
      next.push({ ...lot });
      continue;
    }
    const take = Math.min(lot.cents, left);
    left -= take;
    const remain = lot.cents - take;
    if (remain > 0) next.push({ cents: remain, earnedMonday: lot.earnedMonday });
  }
  return { used, lots: next };
}

/** Store excess up to the cushion max. Anything past the max is dropped. */
export function depositCushion(lots: readonly CushionLot[], cents: number, earnedMonday: string): CushionLot[] {
  const next = lots.map((lot) => ({ ...lot }));
  const add = Math.max(0, Math.round(cents));
  if (add <= 0) return next;
  const room = Math.max(0, CUSHION_MAX_CENTS - cushionTotal(next));
  const take = Math.min(add, room);
  if (take <= 0) return next;
  const row = next.find((lot) => lot.earnedMonday === earnedMonday);
  if (row) row.cents += take;
  else next.push({ cents: take, earnedMonday });
  return next;
}

function usd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

function fit(line: string, fallback: string): string {
  if (line.length <= 20) return line;
  return fallback.length <= 20 ? fallback : fallback.slice(0, 20);
}

export function copyVariants(input: {
  state: CopyState;
  ownCents: number;
  remainingCents: number;
  filledCents: number;
  targetCents: number;
}): string[] {
  const own = usd(input.ownCents);
  if (input.state === "bank") {
    return [fit(`${own} so far`, own), fit(`${own} collected`, own), fit(`So far ${own}`, own)];
  }
  if (input.state === "hump") {
    const toCover = pct(input.remainingCents, input.targetCents);
    const covered = pct(input.filledCents, input.targetCents);
    return [`${toCover}% to cover`, "Over the hump", `${covered}% covered`];
  }
  if (input.state === "stretch") return ["One sale away", "Almost there", "One more sale"];
  return ["Covered. Now profit.", "In the green", "Week covered"];
}

/** Half the net week target. Covered weeks, the bar, and the work line all use this cut. */
export function halfTargetCents(targetCents: number): number {
  return Math.floor(Math.max(0, Math.round(targetCents)) / 2);
}

/** Green share of the week bar. Covered is a full bar. A zero target matches an empty week. */
export function weekFillPct(filledCents: number, targetCents: number, covered: boolean): number {
  if (covered) return 100;
  const target = Math.max(0, Math.round(targetCents));
  const filled = Math.max(0, Math.round(filledCents));
  if (target <= 0) return 100;
  return Math.min(100, (filled / target) * 100);
}

/** Open-menu headline. Half is half the real net target, and the fill includes cushion already drawn. */
export function menuWorkLine(covered: boolean, filledCents: number, targetCents: number): string {
  if (covered) return "Working harder";
  const target = Math.max(0, Math.round(targetCents));
  const filled = Math.max(0, Math.round(filledCents));
  if (target > 0 && filled >= halfTargetCents(target)) return "Working hard";
  return "Hardly working";
}

/** Covered weeks required to reach level 2, then 3, 4, 5, and 6. Level 1 is the start. */
export const LEVEL_WEEKS = [2, 4, 8, 13, 26] as const;

/** Gold level bar. The number follows covered weeks. The fill is this week's collected share. */
export function menuLevel(input: {
  weeksCovered: number;
  filledCents: number;
  targetCents: number;
  covered: boolean;
}): { level: number; next: number | null; pct: number } {
  const weeks = Math.max(0, Math.round(input.weeksCovered));
  let level = 1;
  for (const need of LEVEL_WEEKS) {
    if (weeks >= need) level += 1;
    else break;
  }
  return {
    level,
    next: level > LEVEL_WEEKS.length ? null : level + 1,
    pct: weekFillPct(input.filledCents, input.targetCents, input.covered),
  };
}

export type DayWork = { date: string; worked: boolean };

function dayIsOpen(key: string, openWeekdays: readonly number[]): boolean {
  return openWeekdays.includes(weekdayOf(key));
}

/**
 * Consecutive open days worked, walking back from today.
 * A day counts when someone clocked time or the day was covered.
 * Today with no clock yet does not break the run.
 */
export function consecutiveWorkedDays(input: {
  today: string;
  openWeekdays: readonly number[];
  days: readonly DayWork[];
  todayWorked: boolean;
}): number {
  const worked = new Map(input.days.map((day) => [day.date, day.worked]));
  let count = 0;
  let cursor = input.today;
  for (let i = 0; i < 800; i++) {
    if (dayIsOpen(cursor, input.openWeekdays)) {
      const hit = cursor === input.today ? input.todayWorked || worked.get(cursor) === true : worked.get(cursor) === true;
      if (hit) count += 1;
      else if (cursor !== input.today) break;
    }
    cursor = addDays(cursor, -1);
  }
  return count;
}

/** Group consecutive worked days by seven: `6 days`, `1 week`, `1 week, 3 days`, `2 weeks`. */
export function formatWorkStreak(days: number): string {
  const count = Math.max(0, Math.floor(days));
  const weeks = Math.floor(count / 7);
  const rest = count % 7;
  const weekPart = weeks === 0 ? "" : `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  const dayPart = rest === 0 && weeks > 0 ? "" : `${rest} ${rest === 1 ? "day" : "days"}`;
  if (weekPart && dayPart) return `${weekPart}, ${dayPart}`;
  return weekPart || dayPart;
}

/** Flame row: the day count in front, `day streak` until a full week, then the week phrase. */
export function streakMark(days: number): { count: number; label: string } {
  const count = Math.max(0, Math.floor(days));
  if (count < 7) return { count, label: "day streak" };
  return { count, label: formatWorkStreak(count) };
}

/** Today counts as soon as this person is clocked in, before the hour has printed. */
export function shownWorkedDays(count: number, todayWorked: boolean, clockedIn: boolean, todayOpen: boolean): number {
  if (clockedIn && todayOpen && !todayWorked) return Math.max(0, count) + 1;
  return Math.max(0, count);
}

export function copyLine(view: WeekView, variant: number): string {
  if (view.lines.length === 0) return "";
  const index = ((variant % view.lines.length) + view.lines.length) % view.lines.length;
  return view.lines[index] ?? "";
}

export type WeekMathInput = {
  today: string;
  ownCents: number;
  lots: readonly CushionLot[];
  weeksCovered: number;
  weeklyTargetCents: number;
  materialsBps: number;
  feeBps: number;
  rentMonthlyCents: number;
  rentEntered: boolean;
  openWeekdays: readonly number[];
  monthOpenDays: number;
};

export function summarizeWeekBar(input: WeekMathInput): WeekView {
  const monday = weekMonday(input.today);
  const alive = expireLots(input.lots, monday);
  const target = weekBarTarget({
    weeklyTargetCents: input.weeklyTargetCents,
    materialsBps: input.materialsBps,
    feeBps: input.feeBps,
    rentMonthlyCents: input.rentMonthlyCents,
    rentEntered: input.rentEntered,
    weekOpenDays: countOpenDays(monday, input.openWeekdays),
    monthOpenDays: input.monthOpenDays,
  });
  const half = halfTargetCents(target);
  const own = Math.max(0, Math.round(input.ownCents));
  const shortfall = Math.max(0, target - own);
  const drawn = drawCushion(alive, shortfall, half);
  const filled = own + drawn.used;
  const covered = target > 0 && own >= half && filled >= target;
  const remaining = Math.max(0, target - filled);
  const over = Math.max(0, own - target);
  const raw = target > 0 ? filled / target : 0;
  const days = openDaysLeft(input.today, input.openWeekdays);
  const pace = remaining <= 0 ? 0 : days > 0 ? Math.ceil(remaining / days) : remaining;
  let state: CopyState = "bank";
  if (covered) state = "covered";
  else if (remaining <= MEDIAN_SALE_CENTS) state = "stretch";
  else if (own >= half) state = "hump";
  return {
    weekStart: monday,
    ownCents: own,
    bankedCents: cushionTotal(alive),
    expiresInWeeks: expiresInWeeks(alive, monday),
    targetCents: target,
    cushionUsedCents: drawn.used,
    remainingCents: remaining,
    overCents: over,
    paceCents: pace,
    covered,
    shownPct: Math.min(1.5, raw),
    barPct: Math.min(1, raw),
    state,
    weeksCovered: input.weeksCovered + (covered ? 1 : 0),
    lines: copyVariants({
      state,
      ownCents: own,
      remainingCents: remaining,
      filledCents: filled,
      targetCents: target,
    }),
  };
}

export function emptyWeek(input: Omit<WeekMathInput, "today" | "ownCents" | "lots" | "weeksCovered"> & {
  today: string;
  weeksCovered?: number;
}): WeekView {
  return summarizeWeekBar({
    ...input,
    ownCents: 0,
    lots: [],
    weeksCovered: input.weeksCovered ?? 0,
  });
}

/** Close this Monday and open the next one. The streak grows only when own sales covered the week, and a miss resets it. */
export function closeWeek(input: {
  weekStart: string;
  ownCents: number;
  lots: readonly CushionLot[];
  targetCents: number;
  weeksCovered: number;
}): { weekStart: string; lots: CushionLot[]; weeksCovered: number; covered: boolean } {
  const alive = expireLots(input.lots, input.weekStart);
  const half = halfTargetCents(input.targetCents);
  const own = Math.max(0, Math.round(input.ownCents));
  const drawn = drawCushion(alive, Math.max(0, input.targetCents - own), half);
  const covered = input.targetCents > 0 && own >= half && own + drawn.used >= input.targetCents;
  const nextMonday = addDays(input.weekStart, 7);
  return {
    weekStart: nextMonday,
    lots: expireLots(drawn.lots, nextMonday),
    weeksCovered: covered ? input.weeksCovered + 1 : 0,
    covered,
  };
}

const DEMO_BASE = {
  weeklyTargetCents: DEFAULT_WEEKLY_TARGET_CENTS,
  materialsBps: 1_300,
  feeBps: 300,
  rentMonthlyCents: 0,
  rentEntered: false,
  openWeekdays: [1, 2, 3, 4, 5],
  monthOpenDays: 22,
};

export function demoWeek(preset: WeekPreset, today = "2026-10-14"): WeekView {
  if (preset === "mid") return summarizeWeekBar({ ...DEMO_BASE, today, ownCents: 160_000, lots: [], weeksCovered: 1 });
  if (preset === "stretch") return summarizeWeekBar({ ...DEMO_BASE, today, ownCents: 230_000, lots: [], weeksCovered: 1 });
  if (preset === "covered") return summarizeWeekBar({ ...DEMO_BASE, today, ownCents: 389_760, lots: [], weeksCovered: 1 });
  if (preset === "cushion") {
    return summarizeWeekBar({
      ...DEMO_BASE,
      today,
      ownCents: 80_000,
      lots: [{ cents: 120_000, earnedMonday: "2026-09-28" }],
      weeksCovered: 1,
    });
  }
  return summarizeWeekBar({ ...DEMO_BASE, today, ownCents: 80_000, lots: [], weeksCovered: 1 });
}
