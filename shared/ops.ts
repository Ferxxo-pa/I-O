import { z } from "zod";
import {
  DEFAULT_FIGHT_SETTINGS,
  addDays,
  dailyFixedCents,
  isOpenKey,
  openDaysInMonth,
  weekdayOfKey,
  type FightSettings,
  type HourShare,
} from "./fight";

/** Records stay on one company and one location. No second login system. */
export type ShopScope = { companyId: string; locationId: string };

export function sameScope(row: ShopScope, scope: ShopScope): boolean {
  return row.companyId === scope.companyId && row.locationId === scope.locationId;
}

export function scopeKey(scope: ShopScope): string {
  return `${scope.companyId}|${scope.locationId}`;
}

export const levelRowSchema = z.object({
  level: z.number().int().min(1).max(100),
  /** Team unlock at this level. A name the shop chose. Not money. */
  reward: z.string().trim().min(1).max(48),
});

export const levelRulesSchema = z
  .object({
    clearsInARow: z.number().int().min(1).max(60),
    table: z.array(levelRowSchema).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    const levels = value.table.map((row) => row.level);
    if (new Set(levels).size !== levels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each level is listed once",
        path: ["table"],
      });
    }
  });

export type LevelRules = z.infer<typeof levelRulesSchema>;

export const DEFAULT_LEVEL_RULES: LevelRules = {
  clearsInARow: 5,
  table: [
    { level: 2, reward: "team lunch" },
    { level: 3, reward: "team playlist pick" },
    { level: 4, reward: "early close on a won Friday" },
  ],
};

export type LevelStep = {
  at: number;
  date: string;
  fromLevel: number;
  toLevel: number;
  reason: string;
  companyId: string;
  locationId: string;
};

/** The unlock named on this level, if the shop set one. */
export function unlockName(level: number, rules: LevelRules): string | null {
  const reward = rules.table.find((row) => row.level === level)?.reward.trim();
  return reward ? reward : null;
}

/** One open day. A miss resets the run. Every N clears in a row raises the level by one. */
export function advanceLevel(input: {
  level: number;
  consecutive: number;
  rules: LevelRules;
  cleared: boolean;
}): { level: number; consecutive: number; event: { from: number; to: number; reason: string } | null } {
  if (!input.cleared) return { level: input.level, consecutive: 0, event: null };
  const consecutive = input.consecutive + 1;
  if (consecutive % input.rules.clearsInARow !== 0) {
    return { level: input.level, consecutive, event: null };
  }
  const to = input.level + 1;
  return {
    level: to,
    consecutive,
    event: {
      from: input.level,
      to,
      reason: `${input.rules.clearsInARow} open days cleared`,
    },
  };
}

/** How far the current level is toward the next one. A finished step starts the next bar at empty. */
export function levelProgress(level: number, consecutive: number, clearsInARow: number): { level: number; next: number; pct: number } {
  const step = Math.max(1, Math.round(clearsInARow));
  const current = Math.max(0, Math.round(level));
  const into = ((Math.max(0, Math.round(consecutive)) % step) + step) % step;
  return { level: current, next: current + 1, pct: (into / step) * 100 };
}

/** Small line under the streak. Names the next team unlock and the days left in this run. */
export function levelUnlockLine(level: number, consecutive: number, rules: LevelRules): string {
  const every = Math.max(1, rules.clearsInARow);
  const into = ((consecutive % every) + every) % every;
  const left = into === 0 ? every : every - into;
  const day = left === 1 ? "day" : "days";
  const current = Math.max(0, level);
  const reward = unlockName(current + 1, rules);
  if (reward) return `Lv ${current} · ${reward} in ${left} ${day}`;
  return `Lv ${current} · ${left} ${day} to Lv ${current + 1}`;
}

/** The week celebration is Friday only, and only after the week is already won. */
export function weekWonFriday(date: string, weekCleared: boolean): boolean {
  return weekCleared && weekdayOfKey(date) === 5;
}

export function mondayOf(key: string): string {
  const weekday = weekdayOfKey(key);
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return addDays(key, delta);
}

export function openDatesInWeek(monday: string, openWeekdays: readonly number[]): string[] {
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const key = addDays(monday, i);
    if (isOpenKey(key, openWeekdays)) dates.push(key);
  }
  return dates;
}

/** Week target: this week's wages, plus a full week of daily fixed costs. */
export function weeklyBreakEven(input: {
  wagesCents: number;
  monthlyFixedCents: number;
  monthOpenDays: number;
  weekOpenDays: number;
  materialsBps: number;
  feeBps: number;
}): number {
  const marginBps = 10_000 - input.materialsBps - input.feeBps;
  if (marginBps <= 0) throw new Error("Materials and fees must leave a margin");
  const fixed = dailyFixedCents(input.monthlyFixedCents, input.monthOpenDays) * Math.max(0, input.weekOpenDays);
  const burden = Math.round((Math.max(0, input.wagesCents) * 11) / 10);
  return Math.ceil(((burden + fixed) * 10_000) / marginBps);
}

export function applyWeekStreak(streak: number, cleared: boolean): number {
  if (cleared) return streak + 1;
  return Math.max(0, streak - 1);
}

export type DayPot = {
  date: string;
  collectedCents: number;
  wageCents: number;
  potCents: number;
  payoutPotCents: number;
  hours: HourShare[];
};

export type WeekSummary = {
  weekStart: string;
  collectedCents: number;
  wageCents: number;
  breakEvenCents: number;
  cleared: boolean;
};

export function summarizeWeek(monday: string, days: DayPot[], settings: FightSettings): WeekSummary {
  const inWeek = days.filter((day) => mondayOf(day.date) === monday);
  const collectedCents = inWeek.reduce((sum, day) => sum + Math.max(0, day.collectedCents), 0);
  const wageCents = inWeek.reduce((sum, day) => sum + Math.max(0, day.wageCents), 0);
  const [year, month] = monday.split("-").map(Number);
  const weekOpenDays = openDatesInWeek(monday, settings.openWeekdays).length;
  const breakEven = weeklyBreakEven({
    wagesCents: wageCents,
    monthlyFixedCents: settings.fixedMonthlyCents,
    monthOpenDays: openDaysInMonth(year, month, settings.openWeekdays),
    weekOpenDays,
    materialsBps: settings.materialsBps,
    feeBps: settings.feeBps,
  });
  return {
    weekStart: monday,
    collectedCents,
    wageCents,
    breakEvenCents: breakEven,
    cleared: breakEven > 0 && collectedCents >= breakEven,
  };
}

export type PipState = "hit" | "miss" | "today" | "ahead" | "off";

export type DayPip = {
  date: string;
  state: PipState;
  filled: boolean;
};

/** Mon–Sun pips. Closed days stay faint. Today pulses in the client. */
export function buildWeekPips(input: {
  today: string;
  openWeekdays: readonly number[];
  clearedDates: readonly string[];
  todayCleared: boolean;
}): DayPip[] {
  const monday = mondayOf(input.today);
  const cleared = new Set(input.clearedDates);
  const pips: DayPip[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    if (!isOpenKey(date, input.openWeekdays)) {
      pips.push({ date, state: "off", filled: false });
      continue;
    }
    if (date === input.today) {
      pips.push({ date, state: "today", filled: input.todayCleared || cleared.has(date) });
      continue;
    }
    if (date < input.today) {
      const filled = cleared.has(date);
      pips.push({ date, state: filled ? "hit" : "miss", filled });
      continue;
    }
    pips.push({ date, state: "ahead", filled: false });
  }
  return pips;
}

export function ownLoginPct(roster: number, linked: number): number | null {
  if (roster <= 0) return null;
  return Math.round((Math.min(Math.max(0, linked), roster) / roster) * 100);
}

export type ReadinessCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export function readiness(input: {
  squareToken: boolean;
  webhookConfigured: boolean;
  webhookSeen: boolean;
  pinSet: boolean;
  rentEntered: boolean;
  ratesOk: boolean;
  rateDetail: string;
  ownLoginPct: number | null;
  ownLoginDetail: string;
}): { ready: boolean; checks: ReadinessCheck[] } {
  const webhookOk = input.webhookConfigured && input.webhookSeen;
  let webhookDetail = "Add the signature key and the notification URL";
  if (input.webhookConfigured && input.webhookSeen) webhookDetail = "Signed webhook received";
  else if (input.webhookConfigured) webhookDetail = "Configured, waiting on a delivery";

  const checks: ReadinessCheck[] = [
    {
      id: "square",
      label: "Square token",
      ok: input.squareToken,
      detail: input.squareToken ? "Connected" : "Add SQUARE_ACCESS_TOKEN",
    },
    {
      id: "webhook",
      label: "Webhook",
      ok: webhookOk,
      detail: webhookDetail,
    },
    {
      id: "pin",
      label: "Shop PIN",
      ok: input.pinSet,
      detail: input.pinSet ? "Set" : "Set a 4 to 8 digit PIN",
    },
    {
      id: "rates",
      label: "Pay rates",
      ok: input.ratesOk,
      detail: input.rateDetail,
    },
    {
      id: "rent",
      label: "Rent",
      ok: input.rentEntered,
      detail: input.rentEntered ? "Included in fixed costs" : "Add rent, then mark it included",
    },
    {
      id: "login",
      label: "Own login",
      ok: input.ownLoginPct === 100,
      detail: input.ownLoginDetail,
    },
  ];
  return { ready: checks.every((check) => check.ok), checks };
}

const crewMateSchema = z.object({
  name: z.string(),
  in: z.boolean(),
});

export const opsViewSchema = z.object({
  scope: z.object({
    companyId: z.string(),
    locationId: z.string(),
  }),
  level: z.number().int(),
  consecutiveClears: z.number().int(),
  rules: levelRulesSchema,
  history: z.array(
    z.object({
      at: z.number(),
      date: z.string(),
      fromLevel: z.number().int(),
      toLevel: z.number().int(),
      reason: z.string(),
    }),
  ),
  weekStreak: z.number().int(),
  week: z.object({
    weekStart: z.string(),
    collectedCents: z.number().int(),
    breakEvenCents: z.number().int(),
    cleared: z.boolean(),
  }),
  /** Names only. Green when clocked in. No dollars and no hours. */
  crew: z.array(crewMateSchema),
  pips: z.array(
    z.object({
      date: z.string(),
      state: z.enum(["hit", "miss", "today", "ahead", "off"]),
      filled: z.boolean(),
    }),
  ),
});

export type OpsView = z.infer<typeof opsViewSchema>;

export function demoOps(scene: "morning" | "crit" | "cleared" | "idle"): OpsView {
  const collected = scene === "cleared" ? 164_000 : scene === "crit" ? 240_000 : 24_000;
  const wages = scene === "cleared" ? 48_000 : scene === "crit" ? 220_000 : 18_000;
  const payoutPot = scene === "cleared" ? 8_545 : 0;
  const week = summarizeWeek(
    "2026-10-12",
    [
      {
        date: "2026-10-14",
        collectedCents: collected,
        wageCents: wages,
        potCents: payoutPot,
        payoutPotCents: payoutPot,
        hours:
          scene === "cleared"
            ? [
                { id: "ada", name: "Ada", ms: 5 * 3_600_000 },
                { id: "ben", name: "Ben", ms: 3 * 3_600_000 },
                { id: "sol", name: "Sol", ms: 2 * 3_600_000 },
              ]
            : [{ id: "ada", name: "Ada", ms: 4 * 3_600_000 }],
      },
    ],
    DEFAULT_FIGHT_SETTINGS,
  );
  const todayCleared = scene === "cleared";
  const pips = buildWeekPips({
    today: "2026-10-14",
    openWeekdays: DEFAULT_FIGHT_SETTINGS.openWeekdays,
    clearedDates: todayCleared
      ? ["2026-10-12", "2026-10-13", "2026-10-14"]
      : ["2026-10-12", "2026-10-13"],
    todayCleared,
  });
  return {
    scope: { companyId: "shop", locationId: "local" },
    level: 1,
    consecutiveClears: 3,
    rules: DEFAULT_LEVEL_RULES,
    history: [
      {
        at: Date.UTC(2026, 9, 9, 18, 0, 0),
        date: "2026-10-09",
        fromLevel: 0,
        toLevel: 1,
        reason: "5 open days cleared",
      },
    ],
    weekStreak: 2,
    week,
    crew:
      scene === "idle"
        ? [
            { name: "Ada", in: false },
            { name: "Ben", in: false },
            { name: "Sol", in: false },
          ]
        : scene === "cleared"
          ? [
              { name: "Ada", in: true },
              { name: "Ben", in: true },
              { name: "Sol", in: true },
            ]
          : [
              { name: "Ada", in: true },
              { name: "Ben", in: false },
              { name: "Sol", in: false },
            ],
    pips,
  };
}

export function demoReadiness(): { ready: boolean; checks: ReadinessCheck[] } {
  return readiness({
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
}
