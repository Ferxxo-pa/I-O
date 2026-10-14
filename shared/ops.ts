import { z } from "zod";
import {
  DEFAULT_FIGHT_SETTINGS,
  addDays,
  dailyFixedCents,
  isOpenKey,
  openDaysInMonth,
  potCents,
  splitPot,
  weekdayOfKey,
  type FightSettings,
  type HourShare,
  type PotShare,
} from "./fight";

/** Records and payouts stay on one company and one location. No second login system. */
export type ShopScope = { companyId: string; locationId: string };

export function sameScope(row: ShopScope, scope: ShopScope): boolean {
  return row.companyId === scope.companyId && row.locationId === scope.locationId;
}

export function scopeKey(scope: ShopScope): string {
  return `${scope.companyId}|${scope.locationId}`;
}

export const levelRowSchema = z.object({
  level: z.number().int().min(1).max(100),
  /** Extra dollars per hour, in cents. Recorded here. Never written to Square. */
  payBumpCents: z.number().int().min(0).max(1_000_000),
  /** Extra pot share at this level, in basis points. Added on the weekly payout only. */
  potBonusBps: z.number().int().min(0).max(10_000),
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
    { level: 1, payBumpCents: 50, potBonusBps: 0 },
    { level: 2, payBumpCents: 100, potBonusBps: 100 },
    { level: 3, payBumpCents: 200, potBonusBps: 200 },
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

export function levelReward(level: number, rules: LevelRules): { payBumpCents: number; potBonusBps: number } {
  if (level <= 0) return { payBumpCents: 0, potBonusBps: 0 };
  const row = rules.table
    .filter((item) => item.level <= level)
    .sort((a, b) => b.level - a.level)[0];
  if (!row) return { payBumpCents: 0, potBonusBps: 0 };
  return { payBumpCents: row.payBumpCents, potBonusBps: row.potBonusBps };
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

export type WeekShare = PotShare & { ms: number };

export type WeekSummary = {
  weekStart: string;
  collectedCents: number;
  wageCents: number;
  breakEvenCents: number;
  potCents: number;
  cleared: boolean;
  shares: WeekShare[];
};

export function splitPotWithHours(pot: number, people: HourShare[]): WeekShare[] {
  const rows = people.filter((person) => person.ms > 0);
  if (pot <= 0) return rows.map((person) => ({ id: person.id, name: person.name, cents: 0, ms: person.ms }));
  const shares = splitPot(pot, rows);
  const ms = new Map(rows.map((person) => [person.id, person.ms]));
  return shares.map((share) => ({ ...share, ms: ms.get(share.id) ?? 0 }));
}

function mergeHourShares(days: DayPot[]): HourShare[] {
  const map = new Map<string, HourShare>();
  for (const day of days) {
    for (const person of day.hours) {
      if (person.ms <= 0) continue;
      const prev = map.get(person.id);
      if (prev) {
        prev.ms += person.ms;
        if (person.name) prev.name = person.name;
      } else {
        map.set(person.id, { ...person });
      }
    }
  }
  return Array.from(map.values());
}

export function summarizeWeek(monday: string, days: DayPot[], settings: FightSettings): WeekSummary {
  const inWeek = days.filter((day) => mondayOf(day.date) === monday);
  const collectedCents = inWeek.reduce((sum, day) => sum + Math.max(0, day.collectedCents), 0);
  const wageCents = inWeek.reduce((sum, day) => sum + Math.max(0, day.wageCents), 0);
  const potTotal = inWeek.reduce((sum, day) => sum + Math.max(0, day.payoutPotCents), 0);
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
    potCents: potTotal,
    cleared: breakEven > 0 && collectedCents >= breakEven,
    shares: splitPotWithHours(potTotal, mergeHourShares(inWeek)),
  };
}

export type PayoutStatus = "open" | "paid";

export type Payout = ShopScope & {
  weekStart: string;
  potCents: number;
  shares: WeekShare[];
  status: PayoutStatus;
  approvedAt: number | null;
};

/** Marks a closed week paid. Does not touch wages. A second approve leaves the row as it is. */
export function markPaid(payouts: Payout[], scope: ShopScope, weekStart: string, at: number): Payout[] {
  const index = payouts.findIndex((row) => row.weekStart === weekStart && sameScope(row, scope));
  if (index < 0) throw new Error("That week is not closed");
  const row = payouts[index];
  if (row.status === "paid") return payouts;
  return payouts.map((item, i) => (i === index ? { ...item, status: "paid", approvedAt: at } : item));
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function payoutCsv(payouts: Payout[]): string {
  const lines = ["week_start,person,hours,share_dollars,status"];
  const ordered = [...payouts].sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.companyId.localeCompare(b.companyId));
  for (const payout of ordered) {
    const rows = payout.shares.length > 0 ? payout.shares : [{ id: "", name: "", cents: 0, ms: 0 }];
    for (const share of rows) {
      const hours = (share.ms / 3_600_000).toFixed(2);
      const dollars = (share.cents / 100).toFixed(2);
      lines.push(
        [payout.weekStart, csvCell(share.name), hours, dollars, payout.status].join(","),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export type ChaseInvoice = {
  id: string;
  title: string;
  status: string;
  dueCents: number;
  quote: boolean;
  teamMemberId: string | null;
};

function shortTitle(title: string, fallback: string): string {
  const text = title.trim() || fallback;
  return text.length > 22 ? `${text.slice(0, 21)}…` : text;
}

function wholeDollars(cents: number): string {
  return Math.max(0, Math.round(cents / 100)).toLocaleString("en-US");
}

/**
 * One line when the day is behind a straight pace from open to close.
 * Late means the shop hour is at or after `lateHour`.
 */
export function suggestMove(input: {
  hour: number;
  collectedCents: number;
  breakEvenCents: number;
  invoices: ChaseInvoice[];
  openHour?: number;
  closeHour?: number;
  lateHour?: number;
}): string | null {
  const openHour = input.openHour ?? 8;
  const closeHour = input.closeHour ?? 17;
  const lateHour = input.lateHour ?? 15;
  if (input.hour < lateHour) return null;
  if (input.breakEvenCents <= 0) return null;
  if (input.collectedCents >= input.breakEvenCents) return null;
  const span = Math.max(1, closeHour - openHour);
  const progress = Math.min(1, Math.max(0, (input.hour - openHour) / span));
  const expected = input.breakEvenCents * progress;
  if (input.collectedCents >= expected) return null;

  const chase = input.invoices
    .filter((invoice) => !invoice.quote && invoice.dueCents > 0)
    .sort((a, b) => b.dueCents - a.dueCents)[0];
  if (chase) return `Chase $${wholeDollars(chase.dueCents)} · ${shortTitle(chase.title, "Invoice")}`;

  const quote = input.invoices.find((invoice) => invoice.quote);
  if (quote) return `Follow up · ${shortTitle(quote.title, "Quote")}`;

  const left = Math.max(1, Math.ceil((input.breakEvenCents - input.collectedCents) / 100));
  return `Behind pace · $${left.toLocaleString("en-US")} to go`;
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

const weekShareSchema = z.object({
  id: z.string(),
  name: z.string(),
  cents: z.number().int(),
  ms: z.number().int(),
});

const payoutSchema = z.object({
  companyId: z.string(),
  locationId: z.string(),
  weekStart: z.string(),
  potCents: z.number().int(),
  shares: z.array(weekShareSchema),
  status: z.enum(["open", "paid"]),
  approvedAt: z.number().int().nullable(),
});

export const opsViewSchema = z.object({
  scope: z.object({
    companyId: z.string(),
    locationId: z.string(),
  }),
  level: z.number().int(),
  consecutiveClears: z.number().int(),
  rules: levelRulesSchema,
  payBumpCents: z.number().int(),
  potBonusBps: z.number().int(),
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
    potCents: z.number().int(),
    cleared: z.boolean(),
    shares: z.array(weekShareSchema),
  }),
  payout: payoutSchema.nullable(),
  nudge: z.string().nullable(),
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
  const reward = levelReward(1, DEFAULT_LEVEL_RULES);
  const nudge = suggestMove({
    hour: scene === "cleared" ? 11 : 16,
    collectedCents: collected,
    breakEvenCents: scene === "cleared" ? 78_550 : scene === "crit" ? 400_000 : 39_265,
    invoices: [
      { id: "inv_booth", title: "Booth", status: "UNPAID", dueCents: 42_000, quote: false, teamMemberId: "ada" },
      { id: "inv_patio", title: "Patio", status: "DRAFT", dueCents: 0, quote: true, teamMemberId: null },
    ],
  });
  return {
    scope: { companyId: "shop", locationId: "local" },
    level: 1,
    consecutiveClears: 3,
    rules: DEFAULT_LEVEL_RULES,
    payBumpCents: reward.payBumpCents,
    potBonusBps: reward.potBonusBps,
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
    payout: {
      companyId: "shop",
      locationId: "local",
      weekStart: "2026-10-05",
      potCents: 8_500,
      shares: [
        { id: "ada", name: "Ada", cents: 4_250, ms: 5 * 3_600_000 },
        { id: "ben", name: "Ben", cents: 2_550, ms: 3 * 3_600_000 },
        { id: "sol", name: "Sol", cents: 1_700, ms: 2 * 3_600_000 },
      ],
      status: scene === "cleared" ? "paid" : "open",
      approvedAt: scene === "cleared" ? Date.UTC(2026, 9, 12, 18, 0, 0) : null,
    },
    nudge,
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
