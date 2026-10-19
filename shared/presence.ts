import { z } from "zod";
import { SHOP_ZONE, addDays, isOpenKey, startOfZonedDay, zonedParts } from "./fight";
import { weekMonday } from "./week";

/**
 * Presence is derived from the append-only punch log.
 * Shop hours are a hint. Early and late punches still open and close a day.
 * Time away, once it is a real break, never counts as worked.
 */

export const SHOP_PRESENCE = {
  label: "EZ Designs",
  address: "403 E Ben White Blvd, Austin, TX",
  tz: SHOP_ZONE,
} as const;

export const DEFAULT_DAY = {
  /** First arrival inside this window is "on time". Outside it still clocks in. */
  arriveStartMin: 6 * 60,
  arriveEndMin: 12 * 60,
  /** A leave in this window becomes lunch. Other leaves become a short break. */
  lunchStartMin: 11 * 60,
  lunchEndMin: 14 * 60,
  /** Away less than this, if they come back, is ignored. Default 10 minutes. */
  minAwayMs: 10 * 60 * 1000,
  normalOpenMin: 9 * 60,
  normalCloseMin: 17 * 60,
  /** Absolute latest return. Default 7:00 PM. */
  dayCloseMin: 19 * 60,
  /** Also close this long after normal close. Default 2 hours. */
  closeGraceMs: 2 * 60 * 60 * 1000,
  openWeekdays: [1, 2, 3, 4, 5] as number[],
  tz: SHOP_PRESENCE.tz,
  /**
   * Shop streak and week. This many people must be on the clock together.
   * Default 1, so one accepted arrival still counts.
   */
  shopDayMinPeople: 1,
  /** Minutes of overlap required. Null means no minute gate. */
  shopDayMinMinutes: null as number | null,
};

export type DayConfig = {
  arriveStartMin: number;
  arriveEndMin: number;
  lunchStartMin: number;
  lunchEndMin: number;
  minAwayMs: number;
  normalOpenMin: number;
  normalCloseMin: number;
  dayCloseMin: number;
  closeGraceMs: number;
  openWeekdays: number[];
  tz: typeof SHOP_ZONE;
  shopDayMinPeople: number;
  shopDayMinMinutes: number | null;
};

export const punchTypeSchema = z.enum(["arrive", "leave"]);
export type PunchType = z.infer<typeof punchTypeSchema>;

export const punchRecordSchema = z.object({
  id: z.string(),
  personId: z.string(),
  personName: z.string(),
  type: punchTypeSchema,
  ts: z.number(),
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number(),
  source: z.string().max(32),
  accepted: z.boolean(),
  reason: z.string().nullable(),
  receivedAt: z.number(),
  closesDay: z.boolean().default(false),
  distanceM: z.number().default(0),
  /** Set on a synthesized close, for example auto_closed. Absent on older lines. */
  flag: z.string().max(32).nullable().default(null),
});
export type PunchRecord = z.infer<typeof punchRecordSchema>;

export type DayEvent = {
  type: PunchType;
  ts: number;
  closesDay?: boolean;
};

export type BreakKind = "lunch" | "short";

export type DayBreak = {
  start: number;
  end: number | null;
  kind: BreakKind;
};

export type DayPhase = "out" | "working" | "pending" | "break" | "closed";

export type PersonDay = {
  date: string;
  phase: DayPhase;
  clockInTs: number | null;
  early: boolean;
  late: boolean;
  breaks: DayBreak[];
  /** First leave of the current absence. Work stops here when the absence sticks. */
  leaveTs: number | null;
  /** Latest leave. The day closes at this time. */
  closedAt: number | null;
  breakKind: BreakKind | null;
  workedMs: number;
  present: boolean;
};

export function cutoffMinutes(config: DayConfig): number {
  const fromClose = config.normalCloseMin + Math.round(config.closeGraceMs / 60_000);
  return Math.min(config.dayCloseMin, fromClose);
}

export function shopDateStart(date: string, tz = SHOP_PRESENCE.tz): number {
  const probe = Date.parse(`${date}T18:00:00.000Z`);
  const start = startOfZonedDay(Number.isFinite(probe) ? probe : Date.now(), tz);
  if (zonedParts(start, tz).key === date) return start;
  const next = startOfZonedDay(start + 30 * 3_600_000, tz);
  return zonedParts(next, tz).key === date ? next : start;
}

export function minutesOf(ts: number, tz: typeof SHOP_ZONE): number {
  const parts = zonedParts(ts, tz);
  return parts.hour * 60 + parts.minute;
}

function breakKindAt(ts: number, config: DayConfig): BreakKind {
  const minutes = minutesOf(ts, config.tz);
  if (minutes >= config.lunchStartMin && minutes <= config.lunchEndMin) return "lunch";
  return "short";
}

function sumBreaks(breaks: readonly DayBreak[], from: number, to: number): number {
  let away = 0;
  for (const entry of breaks) {
    const stop = entry.end ?? to;
    const start = Math.max(entry.start, from);
    const end = Math.min(stop, to);
    if (end > start) away += end - start;
  }
  return away;
}

/**
 * Fold one person's accepted punches for one shop date.
 * `now` decides whether an open leave is still a short trip, a break, or a closed day.
 */
export function deriveDay(
  events: readonly DayEvent[],
  config: DayConfig,
  now: number,
  date = zonedParts(now, config.tz).key,
): PersonDay {
  const cutoff = shopDateStart(date, config.tz) + cutoffMinutes(config) * 60_000;
  const ordered = events
    .filter((event) => zonedParts(event.ts, config.tz).key === date)
    .slice()
    .sort((a, b) => a.ts - b.ts);

  let clockInTs: number | null = null;
  let awayFrom: number | null = null;
  let lastLeave: number | null = null;
  let awayCloses = false;
  const breaks: DayBreak[] = [];
  let closedAt: number | null = null;
  let mode: "out" | "in" | "away" = "out";

  const closeAt = (ts: number) => {
    if (awayFrom != null && ts > awayFrom) {
      breaks.push({ start: awayFrom, end: ts, kind: breakKindAt(awayFrom, config) });
    }
    closedAt = ts;
    mode = "out";
    awayFrom = null;
  };

  for (const event of ordered) {
    if (closedAt != null) continue;
    if (event.type === "arrive") {
      if (clockInTs == null) {
        clockInTs = event.ts;
        mode = "in";
        continue;
      }
      if (mode === "away" && awayFrom != null) {
        if (event.ts - awayFrom >= config.minAwayMs) {
          breaks.push({
            start: awayFrom,
            end: event.ts,
            kind: breakKindAt(awayFrom, config),
          });
        }
        awayFrom = null;
        lastLeave = null;
        awayCloses = false;
        mode = "in";
      }
      continue;
    }
    if (clockInTs == null || event.ts < clockInTs) continue;
    if (mode === "in") {
      awayFrom = event.ts;
      lastLeave = event.ts;
      awayCloses = Boolean(event.closesDay);
      mode = "away";
    } else if (mode === "away") {
      lastLeave = event.ts;
      if (event.closesDay) awayCloses = true;
    }
    if (awayCloses || (awayFrom != null && awayFrom >= cutoff)) {
      closeAt(lastLeave ?? event.ts);
    }
  }

  let phase: DayPhase = "out";
  let breakKind: BreakKind | null = null;
  if (closedAt != null) {
    phase = "closed";
  } else if (mode === "away" && awayFrom != null && lastLeave != null) {
    const pastCutoff = now >= cutoff || lastLeave >= cutoff;
    if (awayCloses || pastCutoff) {
      closeAt(lastLeave);
      phase = "closed";
    } else if (now - awayFrom >= config.minAwayMs) {
      phase = "break";
      breakKind = breakKindAt(awayFrom, config);
      breaks.push({ start: awayFrom, end: null, kind: breakKind });
    } else {
      phase = "pending";
    }
  } else if (mode === "in" && clockInTs != null) {
    phase = "working";
  }

  const early = clockInTs != null && minutesOf(clockInTs, config.tz) < config.arriveStartMin;
  const late = clockInTs != null && minutesOf(clockInTs, config.tz) > config.arriveEndMin;
  const workEnd =
    phase === "closed"
      ? (closedAt ?? clockInTs ?? now)
      : phase === "break"
        ? (awayFrom ?? now)
        : now;
  const workedMs =
    clockInTs == null ? 0 : Math.max(0, workEnd - clockInTs - sumBreaks(breaks, clockInTs, workEnd));

  return {
    date,
    phase,
    clockInTs,
    early,
    late,
    breaks,
    leaveTs: awayFrom ?? lastLeave,
    closedAt,
    breakKind,
    workedMs,
    present: phase === "working" || phase === "pending",
  };
}

const WEEK_LABELS = ["M", "T", "W", "T", "F", "S", "S"] as const;

/** Dates with any accepted arrival. The shop streak and week use shopWorkedDates. */
export function punchWorkedDates(
  records: readonly { accepted: boolean; type: PunchType; ts: number }[],
  tz = SHOP_PRESENCE.tz,
): Set<string> {
  const dates = new Set<string>();
  for (const row of records) {
    if (!row.accepted || row.type !== "arrive") continue;
    dates.add(zonedParts(row.ts, tz).key);
  }
  return dates;
}

type ShopPunch = {
  personId: string;
  accepted: boolean;
  type: PunchType;
  ts: number;
  closesDay?: boolean;
};

/** Last instant that still belongs to this Chicago shop date. */
function shopDateAsOf(date: string, now: number, tz: typeof SHOP_ZONE): number {
  const start = shopDateStart(date, tz);
  const next = shopDateStart(addDays(date, 1), tz);
  if (now <= start) return start;
  if (next > start && now >= next) return next - 1;
  return now;
}

/** Time this person was on the clock. Breaks are cut out. Early and late still count. */
function onClockSpans(day: PersonDay, now: number): Array<[number, number]> {
  if (day.clockInTs == null) return [];
  const end =
    day.phase === "closed" ? (day.closedAt ?? day.clockInTs) : day.phase === "break" ? (day.leaveTs ?? day.clockInTs) : now;
  if (end <= day.clockInTs) return [];
  const gaps = day.breaks
    .map((entry) => ({ start: entry.start, end: entry.end ?? end }))
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start);
  const spans: Array<[number, number]> = [];
  let cursor = day.clockInTs;
  for (const gap of gaps) {
    const start = Math.max(gap.start, day.clockInTs);
    const stop = Math.min(gap.end, end);
    if (stop <= cursor) continue;
    if (start > cursor) spans.push([cursor, Math.min(start, end)]);
    cursor = Math.max(cursor, stop);
  }
  if (cursor < end) spans.push([cursor, end]);
  return spans.filter(([start, stop]) => stop > start);
}

/** Milliseconds during which at least `minPeople` spans overlap. */
function togetherMs(spans: ReadonlyArray<readonly [number, number]>, minPeople: number): number {
  if (minPeople < 1 || spans.length === 0) return 0;
  const events: Array<{ t: number; d: number }> = [];
  for (const [start, end] of spans) {
    if (end <= start) continue;
    events.push({ t: start, d: 1 });
    events.push({ t: end, d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let count = 0;
  let prev = events[0]?.t ?? 0;
  let total = 0;
  for (const event of events) {
    if (event.t > prev && count >= minPeople) total += event.t - prev;
    count += event.d;
    prev = event.t;
  }
  return total;
}

/**
 * Chicago dates the shop cleared together.
 * Accepted punches only. 9–5 is a hint, not a gate: early and late still count,
 * and a real break does not. With the default of one person and no minute
 * minimum, any accepted arrival counts. A higher headcount needs those people
 * on the clock at the same time. Minutes, when set, are that overlap.
 */
export function shopWorkedDates(records: readonly ShopPunch[], config: DayConfig, now: number): Set<string> {
  const byDate = new Map<string, Map<string, DayEvent[]>>();
  for (const row of records) {
    if (!row.accepted) continue;
    const date = zonedParts(row.ts, config.tz).key;
    let people = byDate.get(date);
    if (!people) {
      people = new Map();
      byDate.set(date, people);
    }
    const events = people.get(row.personId) ?? [];
    events.push({ type: row.type, ts: row.ts, closesDay: row.closesDay });
    people.set(row.personId, events);
  }

  const worked = new Set<string>();
  const minPeople = Math.max(1, Math.floor(config.shopDayMinPeople));
  for (const [date, people] of Array.from(byDate)) {
    const asOf = shopDateAsOf(date, now, config.tz);
    const spans: Array<[number, number]> = [];
    let arrivals = 0;
    let here = 0;
    for (const events of Array.from(people.values())) {
      const day = deriveDay(events, config, asOf, date);
      if (day.clockInTs == null) continue;
      arrivals += 1;
      if (day.phase === "working" || day.phase === "pending") here += 1;
      spans.push(...onClockSpans(day, asOf));
    }
    if (arrivals < minPeople) continue;
    const overlap = togetherMs(spans, minPeople);
    const minutes = config.shopDayMinMinutes;
    if (minutes != null && minutes > 0) {
      if (overlap >= minutes * 60_000) worked.add(date);
      continue;
    }
    if (minPeople <= 1 || overlap > 0 || here >= minPeople) worked.add(date);
  }
  return worked;
}

/** Consecutive open shop days in `worked`. The unit is days, never hours. */
export function presenceStreak(input: {
  today: string;
  worked: ReadonlySet<string>;
  openWeekdays: readonly number[];
  tz?: typeof SHOP_ZONE;
}): number {
  let count = 0;
  let cursor = input.today;
  for (let i = 0; i < 800; i++) {
    if (isOpenKey(cursor, input.openWeekdays, input.tz)) {
      const hit = input.worked.has(cursor);
      if (hit) count += 1;
      else if (cursor !== input.today) break;
    }
    cursor = addDays(cursor, -1);
  }
  return count;
}

export type PresenceWeek = {
  start: string;
  days: Array<{ date: string; label: string; open: boolean; worked: boolean }>;
  workedDays: number;
  openDays: number;
  filledPct: number;
};

export function presenceWeek(input: {
  today: string;
  worked: ReadonlySet<string>;
  openWeekdays: readonly number[];
  tz?: typeof SHOP_ZONE;
}): PresenceWeek {
  const start = weekMonday(input.today);
  const days = WEEK_LABELS.map((label, index) => {
    const date = addDays(start, index);
    const open = isOpenKey(date, input.openWeekdays, input.tz);
    return { date, label, open, worked: input.worked.has(date) };
  });
  const openDays = days.filter((day) => day.open);
  const workedDays = openDays.filter((day) => day.worked).length;
  return {
    start,
    days,
    workedDays,
    openDays: openDays.length,
    filledPct: openDays.length === 0 ? 0 : workedDays / openDays.length,
  };
}

export function dayLabel(day: PersonDay): { label: string; detail: string } {
  if (day.phase === "working" || day.phase === "pending") {
    const detail = day.early ? "Early" : day.late ? "Late" : day.phase === "pending" ? "Stepped out" : "On time";
    return { label: "Clocked in", detail };
  }
  if (day.phase === "break") {
    return { label: "On break", detail: day.breakKind === "lunch" ? "Lunch" : "Short break" };
  }
  if (day.phase === "closed") return { label: "Day closed", detail: "Left for the day" };
  return { label: "Out", detail: "Not in yet" };
}

export const PRESENCE_REASON_TEXT: Record<string, string> = {
  outside_fence: "Outside the shop",
  low_accuracy: "Location isn't accurate enough",
  stale_fix: "Location reading is too old",
  future_fix: "Location time doesn't match",
  missing_fix: "No location reading",
  wrong_person: "You can only punch for yourself",
  wrong_pin: "Wrong PIN",
  day_closed: "That day is already closed",
  desk_required: "I'm here needs the shop computer",
};

export function presenceReasonText(reason: string | null): string | null {
  if (!reason) return null;
  return PRESENCE_REASON_TEXT[reason] ?? "Not recorded";
}

export const presenceDotSchema = z.object({
  personId: z.string(),
  name: z.string(),
  phase: z.enum(["out", "working", "pending", "break", "closed"]),
  present: z.boolean(),
  label: z.string(),
  detail: z.string(),
  lastAccepted: z.boolean().nullable(),
  lastMessage: z.string().nullable(),
  lastTs: z.number().nullable(),
});
export type PresenceDot = z.infer<typeof presenceDotSchema>;

export const presenceViewSchema = z.object({
  tz: z.string(),
  now: z.number(),
  date: z.string(),
  dots: z.array(presenceDotSchema),
  streakDays: z.number().int(),
  week: z.object({
    start: z.string(),
    days: z.array(
      z.object({
        date: z.string(),
        label: z.string(),
        open: z.boolean(),
        worked: z.boolean(),
      }),
    ),
    workedDays: z.number().int(),
    openDays: z.number().int(),
    filledPct: z.number(),
  }),
  you: presenceDotSchema.nullable(),
  squareMode: z.enum(["dry_run", "live"]),
  shop: z.object({
    label: z.string(),
    address: z.string(),
  }),
});
export type PresenceView = z.infer<typeof presenceViewSchema>;

export function emptyPresence(now = Date.now()): PresenceView {
  const date = zonedParts(now, SHOP_PRESENCE.tz).key;
  return {
    tz: SHOP_PRESENCE.tz,
    now,
    date,
    dots: [],
    streakDays: 0,
    week: presenceWeek({
      today: date,
      worked: new Set(),
      openWeekdays: DEFAULT_DAY.openWeekdays,
      tz: SHOP_PRESENCE.tz,
    }),
    you: null,
    squareMode: "dry_run",
    shop: { label: SHOP_PRESENCE.label, address: SHOP_PRESENCE.address },
  };
}
