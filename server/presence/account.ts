import type { DayPhase, PersonDay } from "@shared/presence";

export type AccountStatus = "working" | "on_break" | "off";

export function accountStatus(phase: DayPhase): AccountStatus {
  if (phase === "working") return "working";
  if (phase === "pending" || phase === "break") return "on_break";
  return "off";
}

/** Whole cents for worked time. Never negative. Exact for an integer rate and hour. */
export function moneyCentsFor(workedMs: number, rateCents: number, hourMs: number): number {
  const ms = Math.max(0, Math.floor(workedMs));
  if (ms === 0 || rateCents <= 0 || hourMs <= 0) return 0;
  return Math.floor((ms * rateCents) / hourMs);
}

/**
 * Minutes the counter is allowed to pay.
 * A pending trip is frozen at the leave. A break or a closed day already
 * excludes that gap in the day fold.
 */
export function paidDay(day: PersonDay, now: number, atLeave: PersonDay | null): { day: PersonDay; accruedMs: number } {
  if (day.phase === "pending" && atLeave) {
    return { day: atLeave, accruedMs: Math.max(0, atLeave.workedMs) };
  }
  return { day, accruedMs: Math.max(0, day.workedMs) };
}

export function clockMinutes(accruedMs: number): number {
  return Math.floor(Math.max(0, accruedMs) / 60_000);
}
