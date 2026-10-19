import {
  DEFAULT_CONFIG,
  DEFAULT_SESSION,
  type AppState,
  type PersonShift,
} from "../schema.ts";
import { DEFAULT_FIGHT_SETTINGS, SHOP_ZONE, buildFightView, zonedParts, openDaysInMonth } from "../fight.ts";
import { DEFAULT_LEVEL_RULES, buildWeekPips, type OpsView } from "../ops.ts";
import {
  DEFAULT_DAY,
  SHOP_PRESENCE,
  dayLabel,
  deriveDay,
  emptyPresence,
  presenceStreak,
  presenceWeek,
  shopWorkedDates,
  type PunchRecord,
} from "../presence.ts";
import { summarizeWeekBar } from "../week.ts";
import type { ShiftLike } from "./clockPlan.ts";

export function shiftToPerson(shift: ShiftLike): PersonShift {
  return {
    personId: shift.personId,
    name: shift.name,
    hourlyCents: shift.hourlyCents,
    clockedIn: shift.clockedIn,
    clockedInAt: shift.clockedInAt,
    hourSegmentStartedAt: shift.hourSegmentStartedAt,
    outputCents: shift.outputCents,
    timecardId: shift.timecardId,
    holdAt: shift.holdAt,
    managedBy: shift.managedBy,
    source: shift.source,
    review: shift.review,
  };
}

/** Strip snapshot. Accrual is computed at read time. Nothing here writes a wage. */
export function cloudState(input: {
  now: number;
  companyId: string;
  locationId: string;
  viewerId: string | null;
  shifts: ShiftLike[];
  collectedCents: number;
  pinSet: boolean;
  people: Array<{ id: string; name: string }>;
  punches: Array<Pick<PunchRecord, "personId" | "accepted" | "type" | "ts" | "closesDay">>;
  squareConnected: boolean;
}): AppState {
  const date = zonedParts(input.now, SHOP_ZONE).key;
  const [year, month] = date.split("-").map(Number);
  const you = input.viewerId ? input.shifts.find((shift) => shift.personId === input.viewerId) : undefined;
  const viewerClockedIn = input.viewerId ? Boolean(you?.clockedIn) : input.shifts.some((shift) => shift.clockedIn);
  const accrued = input.shifts.reduce((sum, shift) => {
    if (!shift.clockedIn || shift.clockedInAt == null) return sum;
    const end = shift.holdAt != null ? Math.min(input.now, shift.holdAt) : input.now;
    const ms = Math.max(0, end - shift.clockedInAt);
    return sum + Math.floor((ms / 3_600_000) * shift.hourlyCents);
  }, 0);
  const week = summarizeWeekBar({
    today: date,
    ownCents: input.collectedCents,
    lots: [],
    weeksCovered: 0,
    weeklyTargetCents: DEFAULT_FIGHT_SETTINGS.weeklyTargetCents,
    materialsBps: DEFAULT_FIGHT_SETTINGS.materialsBps,
    feeBps: DEFAULT_FIGHT_SETTINGS.feeBps,
    rentMonthlyCents: DEFAULT_FIGHT_SETTINGS.rentMonthlyCents,
    rentEntered: DEFAULT_FIGHT_SETTINGS.rentEntered,
    openWeekdays: DEFAULT_FIGHT_SETTINGS.openWeekdays,
    monthOpenDays: openDaysInMonth(year, month, DEFAULT_FIGHT_SETTINGS.openWeekdays),
  });
  const fight = buildFightView({
    date,
    pinSet: input.pinSet,
    collectedCents: input.collectedCents,
    wageCents: accrued,
    sales: [],
    hours: [],
    streak: 0,
    settings: DEFAULT_FIGHT_SETTINGS,
    openDays: openDaysInMonth(year, month, DEFAULT_FIGHT_SETTINGS.openWeekdays),
    week,
  });
  const worked = shopWorkedDates(
    input.punches.map((row) => ({ ...row, closesDay: row.closesDay })),
    { ...DEFAULT_DAY, tz: SHOP_ZONE },
    input.now,
  );
  const presence = emptyPresence(input.now);
  presence.squareMode = input.squareConnected ? "live" : "dry_run";
  presence.streakDays = presenceStreak({
    today: date,
    worked,
    openWeekdays: DEFAULT_DAY.openWeekdays,
    tz: SHOP_ZONE,
  });
  presence.week = presenceWeek({
    today: date,
    worked,
    openWeekdays: DEFAULT_DAY.openWeekdays,
    tz: SHOP_ZONE,
  });
  presence.dots = input.people.map((person) => {
    const events = input.punches
      .filter((row) => row.accepted && row.personId === person.id)
      .map((row) => ({ type: row.type, ts: row.ts, closesDay: row.closesDay }));
    const day = deriveDay(events, { ...DEFAULT_DAY, tz: SHOP_ZONE }, input.now, date);
    const shift = input.shifts.find((entry) => entry.personId === person.id);
    const phase = shift?.clockedIn ? (shift.holdAt != null ? "pending" : "working") : day.phase;
    const label = dayLabel({ ...day, phase });
    return {
      personId: person.id,
      name: person.name,
      phase,
      present: phase === "working" || phase === "pending",
      label: label.label,
      detail: label.detail,
      lastAccepted: null,
      lastMessage: null,
      lastTs: shift?.clockedInAt ?? null,
    };
  });
  const viewerDot = input.viewerId ? presence.dots.find((dot) => dot.personId === input.viewerId) ?? null : null;
  presence.you = viewerDot;
  const ops: OpsView = {
    scope: { companyId: input.companyId, locationId: input.locationId },
    level: 1,
    consecutiveClears: 0,
    rules: DEFAULT_LEVEL_RULES,
    history: [],
    weekStreak: 0,
    week: {
      weekStart: week.weekStart,
      collectedCents: input.collectedCents,
      breakEvenCents: fight.breakEvenCents,
      cleared: week.covered,
    },
    crew: input.people.map((person) => ({
      name: person.name,
      in: Boolean(input.shifts.find((shift) => shift.personId === person.id)?.clockedIn),
    })),
    pips: buildWeekPips({
      today: date,
      openWeekdays: DEFAULT_FIGHT_SETTINGS.openWeekdays,
      clearedDates: [],
      todayCleared: week.covered,
    }),
  };
  return {
    config: { ...DEFAULT_CONFIG },
    square: { connected: input.squareConnected, source: input.squareConnected ? "square" : "demo" },
    session: {
      ...DEFAULT_SESSION,
      collectedCents: input.collectedCents,
      outputCents: accrued,
      clockedIn: viewerClockedIn,
      clockedInAt: you?.clockedInAt ?? null,
      hourSegmentStartedAt: you?.hourSegmentStartedAt ?? null,
      externalShiftId: you?.timecardId ?? null,
    },
    events: [],
    accruedOutputCents: accrued,
    inputMs: you?.clockedInAt ? Math.max(0, input.now - (you.holdAt ?? input.now)) : 0,
    msToNextPrint: 3_600_000,
    serverNow: input.now,
    you: { id: input.viewerId, name: you?.name ?? null, clockedIn: viewerClockedIn },
    fight,
    ops,
    presence,
  };
}

export const SHOP_LABEL = SHOP_PRESENCE.label;
