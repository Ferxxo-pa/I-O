import { zonedParts } from "@shared/fight";
import { shopDateStart, type DayConfig } from "@shared/presence";

export type SessionState = {
  sessionStart: number | null;
  lastSeenAt: number | null;
  stationaryAt: number | null;
};

export type SessionFlag = "over_14h" | "overnight";

/** A phone latch that is still on after the local date changes. */
export function latchedOvernight(sessionStart: number, now: number, tz: DayConfig["tz"]): boolean {
  return zonedParts(sessionStart, tz).key < zonedParts(now, tz).key;
}

export function blankSession(): SessionState {
  return { sessionStart: null, lastSeenAt: null, stationaryAt: null };
}

export function collectionBounds(date: string, day: DayConfig, marginMs: number): { start: number; end: number } {
  const marginMin = Math.round(marginMs / 60_000);
  const dayStart = shopDateStart(date, day.tz);
  return {
    start: dayStart + (day.normalOpenMin - marginMin) * 60_000,
    end: dayStart + (day.normalCloseMin + marginMin) * 60_000,
  };
}

/** Automatic signals are kept only from open minus the margin through close plus the margin. */
export function withinCollection(ts: number, day: DayConfig, marginMs: number): boolean {
  if (!Number.isFinite(ts)) return false;
  const date = zonedParts(ts, day.tz).key;
  const bounds = collectionBounds(date, day, marginMs);
  return ts >= bounds.start && ts <= bounds.end;
}

/**
 * Overnight means the device was still present at the end of one collection
 * window and already present at the start of a later one, or a continuous
 * sighting crossed midnight. A normal leave and a next-day arrival do not.
 */
export function sawOvernight(input: {
  prevSeen: number | null;
  at: number;
  day: DayConfig;
  marginMs: number;
  edgeMs: number;
  continuousGapMs: number;
}): boolean {
  if (input.prevSeen == null || input.at <= input.prevSeen) return false;
  const prevDate = zonedParts(input.prevSeen, input.day.tz).key;
  const nextDate = zonedParts(input.at, input.day.tz).key;
  if (prevDate === nextDate) return false;
  if (input.at - input.prevSeen <= input.continuousGapMs) return true;
  const prevBounds = collectionBounds(prevDate, input.day, input.marginMs);
  const nextBounds = collectionBounds(nextDate, input.day, input.marginMs);
  const stayedLate = input.prevSeen >= prevBounds.end - input.edgeMs;
  const hereEarly = input.at <= nextBounds.start + input.edgeMs;
  return stayedLate && hereEarly;
}

/**
 * Phones that never leave the shop stop counting. The owner clears the flag.
 * A gap longer than the quiet window starts a new session, except overnight.
 */
export function advanceSession(input: {
  session: SessionState;
  at: number;
  stationaryMs: number;
  gapResetMs: number;
  overnight: boolean;
}): { session: SessionState; flag: SessionFlag | null; drives: boolean } {
  if (input.session.stationaryAt != null) {
    return {
      session: {
        ...input.session,
        lastSeenAt: Math.max(input.session.lastSeenAt ?? 0, input.at),
      },
      flag: null,
      drives: false,
    };
  }
  const gap = input.session.lastSeenAt == null ? Number.POSITIVE_INFINITY : input.at - input.session.lastSeenAt;
  const sessionStart = input.session.sessionStart == null || gap > input.gapResetMs ? input.at : input.session.sessionStart;
  let flag: SessionFlag | null = null;
  if (input.overnight) flag = "overnight";
  else if (input.at - sessionStart >= input.stationaryMs) flag = "over_14h";
  if (flag) {
    return {
      session: { sessionStart, lastSeenAt: input.at, stationaryAt: input.at },
      flag,
      drives: false,
    };
  }
  return {
    session: { sessionStart, lastSeenAt: input.at, stationaryAt: null },
    flag: null,
    drives: true,
  };
}
