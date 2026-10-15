import { z } from "zod";
import { emptyWeek, weekViewSchema, type WeekPreset, type WeekView, demoWeek } from "./week";

/**
 * Fight the bar.
 * Break-even for today =
 *   (today's wages × 1.1 + daily fixed costs) / (1 − materials% − fee%)
 * Daily fixed costs = monthly fixed / open days in that month.
 * The shop day is Austin time. Rent is not in the default fixed cost.
 */

export const SHOP_ZONE = "America/Chicago";

export const fightSettingsSchema = z
  .object({
    /** Monthly fixed costs in cents. Default $2,900. Rent is not included. */
    fixedMonthlyCents: z.number().int().min(0).max(100_000_000),
    /** Materials share in basis points. 13% is 1300. */
    materialsBps: z.number().int().min(0).max(9_999),
    /** Card / processor fee in basis points. 3% is 300. */
    feeBps: z.number().int().min(0).max(9_999),
    /** Weekdays the shop is open. 0 is Sunday. */
    openWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    /** Team pot share of revenue above break-even, in basis points. 10% is 1000. */
    potBps: z.number().int().min(0).max(10_000),
    /** Average-sale goal in cents. Default $1,040. */
    avgGoalCents: z.number().int().positive().max(100_000_000),
    /** Owner confirmed rent is inside the weekly target. */
    rentEntered: z.boolean().default(false),
    /** Gross weekly bar before materials, fees, and rent. Default $2,900. */
    weeklyTargetCents: z.number().int().min(0).max(100_000_000).default(290_000),
    /** Monthly rent in cents. Added to the week unless rent is already in the target. */
    rentMonthlyCents: z.number().int().min(0).max(100_000_000).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.materialsBps + value.feeBps >= 10_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Materials and fees must leave a margin",
        path: ["materialsBps"],
      });
    }
    if (new Set(value.openWeekdays).size !== value.openWeekdays.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Open days should be listed once",
        path: ["openWeekdays"],
      });
    }
  });

export type FightSettings = z.infer<typeof fightSettingsSchema>;

export const DEFAULT_FIGHT_SETTINGS: FightSettings = {
  fixedMonthlyCents: 290_000,
  materialsBps: 1_300,
  feeBps: 300,
  openWeekdays: [1, 2, 3, 4, 5],
  potBps: 1_000,
  avgGoalCents: 104_000,
  rentEntered: false,
  weeklyTargetCents: 290_000,
  rentMonthlyCents: 0,
};

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  key: string;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

export function zonedParts(time: number, timeZone = SHOP_ZONE): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(time));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  return {
    year,
    month,
    day,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY[get("weekday")] ?? 0,
    key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function weekdayOfKey(key: string, _timeZone = SHOP_ZONE): number {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isOpenKey(key: string, openWeekdays: readonly number[], timeZone = SHOP_ZONE): boolean {
  return openWeekdays.includes(weekdayOfKey(key, timeZone));
}

export function openDaysInMonth(
  year: number,
  month: number,
  openWeekdays: readonly number[],
  timeZone = SHOP_ZONE,
): number {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let day = 1; day <= days; day++) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (isOpenKey(key, openWeekdays, timeZone)) count += 1;
  }
  return Math.max(1, count);
}

export function addDays(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Open shop days after `startKey` and before `endKey`. */
export function openDaysStrictlyBetween(
  startKey: string,
  endKey: string,
  openWeekdays: readonly number[],
  timeZone = SHOP_ZONE,
): number {
  let count = 0;
  let cursor = addDays(startKey, 1);
  while (cursor < endKey) {
    if (isOpenKey(cursor, openWeekdays, timeZone)) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

const midnightCache = new Map<string, number>();

/** First millisecond of the shop day that contains `time`. */
export function startOfZonedDay(time: number, timeZone = SHOP_ZONE): number {
  const parts = zonedParts(time, timeZone);
  const cacheKey = `${timeZone}|${parts.key}`;
  const cached = midnightCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const wholeSecond = time - (time % 1000);
  const offset =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - wholeSecond;
  let start = Date.UTC(parts.year, parts.month - 1, parts.day) - offset;
  if (zonedParts(start, timeZone).key !== parts.key || zonedParts(start, timeZone).hour !== 0) {
    let lo = time - 36 * 3_600_000;
    let hi = time + 36 * 3_600_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (zonedParts(mid, timeZone).key < parts.key) lo = mid + 1;
      else hi = mid;
    }
    start = lo;
  }
  midnightCache.set(cacheKey, start);
  return start;
}

export function dailyFixedCents(monthlyFixedCents: number, openDays: number): number {
  return Math.round(monthlyFixedCents / Math.max(1, openDays));
}

export function breakEvenCents(input: {
  wagesCents: number;
  monthlyFixedCents: number;
  openDays: number;
  materialsBps: number;
  feeBps: number;
}): number {
  const marginBps = 10_000 - input.materialsBps - input.feeBps;
  if (marginBps <= 0) throw new Error("Materials and fees must leave a margin");
  const burden = Math.round((Math.max(0, input.wagesCents) * 11) / 10);
  const numerator = burden + dailyFixedCents(input.monthlyFixedCents, input.openDays);
  return Math.ceil((numerator * 10_000) / marginBps);
}

/** Where the notch sits on the green-vs-red bar, 0–100 from the left. */
export function notchPercent(breakEven: number, wageCents: number): number {
  const wages = Math.max(0, wageCents);
  const target = Math.max(0, breakEven);
  const denom = target + wages;
  if (denom <= 0) return 0;
  return Math.min(100, Math.max(0, (target / denom) * 100));
}

export function potCents(collectedCents: number, breakEven: number, potBps: number): number {
  const over = Math.max(0, collectedCents - breakEven);
  return Math.floor((over * potBps) / 10_000);
}

export type HourShare = { id: string; name: string; ms: number };

export type PotShare = { id: string; name: string; cents: number };

/** Split the pot by time worked. Remainder cents go to the largest fractional share. */
export function splitPot(pot: number, people: HourShare[]): PotShare[] {
  const rows = people.filter((person) => person.ms > 0);
  const total = rows.reduce((sum, person) => sum + person.ms, 0);
  if (pot <= 0 || total <= 0) return [];
  const drafted = rows.map((person) => {
    const exact = (pot * person.ms) / total;
    const cents = Math.floor(exact);
    return { ...person, cents, frac: exact - cents };
  });
  let left = pot - drafted.reduce((sum, row) => sum + row.cents, 0);
  const order = [...drafted].sort(
    (a, b) => b.frac - a.frac || b.ms - a.ms || a.id.localeCompare(b.id),
  );
  for (const row of order) {
    if (left <= 0) break;
    row.cents += 1;
    left -= 1;
  }
  return drafted.map(({ id, name, cents }) => ({ id, name, cents }));
}

export function applyStreak(streak: number, cleared: boolean): number {
  if (cleared) return streak + 1;
  return Math.max(0, streak - 1);
}

export type HitTier = "small" | "solid" | "big" | "crit";

/** <$100 small, $100–$500 solid, $500–$2,000 big, $2,000+ crit. */
export function hitTier(cents: number): HitTier {
  if (cents >= 200_000) return "crit";
  if (cents >= 50_000) return "big";
  if (cents >= 10_000) return "solid";
  return "small";
}

export function saleTapeLabel(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const body = dollars.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const text = cents < 0 ? `−$${body}` : `+$${body}`;
  return hitTier(cents) === "crit" ? `${text} CRIT` : text;
}

export function averageSaleCents(sales: readonly number[]): number | null {
  if (sales.length === 0) return null;
  const total = sales.reduce((sum, cents) => sum + cents, 0);
  return Math.round(total / sales.length);
}

export const potShareSchema = z.object({
  id: z.string(),
  name: z.string(),
  cents: z.number().int(),
});

export const fightViewSchema = z.object({
  date: z.string(),
  pinSet: z.boolean(),
  todayCollectedCents: z.number().int(),
  todayWageCents: z.number().int(),
  breakEvenCents: z.number().int(),
  toBreakEvenCents: z.number().int(),
  cleared: z.boolean(),
  notchPct: z.number(),
  potCents: z.number().int(),
  shares: z.array(potShareSchema),
  streak: z.number().int(),
  /** Consecutive open days with clock time or a covered day, ending today. */
  workedDays: z.number().int().min(0).default(0),
  /** Today already has clock time or was covered, so a live clock-in must not be counted twice. */
  todayWorked: z.boolean().default(false),
  avgSaleCents: z.number().int().nullable(),
  saleCount: z.number().int(),
  goalCents: z.number().int(),
  settings: fightSettingsSchema,
  week: weekViewSchema,
});

export type FightView = {
  date: string;
  pinSet: boolean;
  todayCollectedCents: number;
  todayWageCents: number;
  breakEvenCents: number;
  toBreakEvenCents: number;
  cleared: boolean;
  notchPct: number;
  potCents: number;
  shares: PotShare[];
  streak: number;
  workedDays: number;
  todayWorked: boolean;
  avgSaleCents: number | null;
  saleCount: number;
  goalCents: number;
  settings: FightSettings;
  week: WeekView;
};

export function buildFightView(input: {
  date: string;
  pinSet: boolean;
  collectedCents: number;
  wageCents: number;
  sales: readonly number[];
  hours: HourShare[];
  streak: number;
  workedDays?: number;
  todayWorked?: boolean;
  settings: FightSettings;
  openDays: number;
  week?: WeekView;
}): FightView {
  const target = breakEvenCents({
    wagesCents: input.wageCents,
    monthlyFixedCents: input.settings.fixedMonthlyCents,
    openDays: input.openDays,
    materialsBps: input.settings.materialsBps,
    feeBps: input.settings.feeBps,
  });
  const cleared = target > 0 && input.collectedCents >= target;
  const pot = cleared ? potCents(input.collectedCents, target, input.settings.potBps) : 0;
  return {
    date: input.date,
    pinSet: input.pinSet,
    todayCollectedCents: input.collectedCents,
    todayWageCents: input.wageCents,
    breakEvenCents: target,
    toBreakEvenCents: Math.max(0, target - input.collectedCents),
    cleared,
    notchPct: notchPercent(target, input.wageCents),
    potCents: pot,
    shares: splitPot(pot, input.hours),
    streak: input.streak,
    workedDays: Math.max(0, Math.round(input.workedDays ?? 0)),
    todayWorked: input.todayWorked ?? false,
    avgSaleCents: averageSaleCents(input.sales),
    saleCount: input.sales.length,
    goalCents: input.settings.avgGoalCents,
    settings: input.settings,
    week:
      input.week ??
      emptyWeek({
        today: input.date,
        weeksCovered: 0,
        weeklyTargetCents: input.settings.weeklyTargetCents,
        materialsBps: input.settings.materialsBps,
        feeBps: input.settings.feeBps,
        rentMonthlyCents: input.settings.rentMonthlyCents,
        rentEntered: input.settings.rentEntered,
        openWeekdays: input.settings.openWeekdays,
        monthOpenDays: input.openDays,
      }),
  };
}

export type DemoScene = "morning" | "crit" | "cleared" | "idle";

export type DemoModel = {
  scene: DemoScene;
  clockedIn: boolean;
  view: FightView;
  /** Sale flashing on the tape, when the scene is the hit itself. */
  hitCents: number | null;
};

const HOUR_MS = 3_600_000;
const DEMO_DATE = "2026-10-14";
const DEMO_OPEN_DAYS = 22;

function demoView(
  scene: DemoScene,
  collectedCents: number,
  wageCents: number,
  sales: number[],
  hours: HourShare[],
  streak: number,
): FightView {
  return buildFightView({
    date: DEMO_DATE,
    pinSet: true,
    collectedCents,
    wageCents,
    sales,
    hours,
    streak,
    settings: DEFAULT_FIGHT_SETTINGS,
    openDays: DEMO_OPEN_DAYS,
  });
}

/** Fixed scenes so the shop can preview the bar without Square sales. */
function withWeek(view: FightView, preset?: WeekPreset | null): FightView {
  if (!preset) return view;
  return { ...view, week: demoWeek(preset, view.date) };
}

export function demoModel(scene: DemoScene, preset?: WeekPreset | null): DemoModel {
  if (scene === "crit") {
    return {
      scene,
      clockedIn: true,
      hitCents: 240_000,
      view: withWeek(demoView("crit", 240_000, 220_000, [240_000], [], 2), preset),
    };
  }
  if (scene === "cleared") {
    return {
      scene,
      clockedIn: true,
      hitCents: null,
      view: withWeek(
        demoView(
          "cleared",
          164_000,
          48_000,
          [90_000, 40_000, 34_000],
          [
            { id: "ada", name: "Ada", ms: 5 * HOUR_MS },
            { id: "ben", name: "Ben", ms: 3 * HOUR_MS },
            { id: "sol", name: "Sol", ms: 2 * HOUR_MS },
          ],
          4,
        ),
        preset,
      ),
    };
  }
  const morning = demoView("morning", 24_000, 18_000, [24_000], [], 2);
  return {
    scene,
    clockedIn: scene !== "idle",
    hitCents: null,
    view: withWeek(morning, preset),
  };
}
