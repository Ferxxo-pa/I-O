import { zonedParts } from "../fight.ts";
import { shopDateStart } from "../presence.ts";
import { shouldAutoClose, type WatchPerson } from "./watch.ts";
import type { DayPhase } from "../presence.ts";

/** One person's shift. The book keeps a single row, so a second timecard cannot open beside it. */
export type ShiftLike = {
  personId: string;
  name: string;
  hourlyCents: number;
  clockedIn: boolean;
  clockedInAt: number | null;
  hourSegmentStartedAt: number | null;
  outputCents: number;
  timecardId: string | null;
  holdAt: number | null;
  managedBy: "presence" | null;
  source: "manual" | "phone-geo" | "phone-wifi" | null;
  review: "auto_closed" | "stationary" | null;
};

export type RemoteCard = {
  personId: string;
  name: string;
  hourlyCents: number;
  timecardId: string;
  open: boolean;
  startedAt: number;
};

export type RemotePlan =
  | { action: "noop" }
  | { action: "adopt"; shift: ShiftLike; emitClockIn: boolean; at: number }
  | { action: "close"; at: number };

/** A brand-new Square open for this person, or the same card again. Never a second local shift. */
export function planRemoteTimecard(
  existing: ShiftLike | undefined,
  card: RemoteCard,
  now: number,
  fallbackHourly: number,
): RemotePlan {
  if (card.open) {
    if (existing?.clockedIn && existing.timecardId === card.timecardId) return { action: "noop" };
    const started = card.startedAt || now;
    const hourly = card.hourlyCents > 0 ? card.hourlyCents : (existing?.hourlyCents ?? fallbackHourly);
    return {
      action: "adopt",
      emitClockIn: !existing?.clockedIn,
      at: started,
      shift: {
        personId: card.personId,
        name: existing?.name || card.name || "Square",
        hourlyCents: hourly,
        clockedIn: true,
        clockedInAt: existing?.clockedIn ? existing.clockedInAt : started,
        hourSegmentStartedAt: existing?.clockedIn ? existing.hourSegmentStartedAt : started,
        outputCents: existing?.outputCents ?? 0,
        timecardId: card.timecardId,
        holdAt: existing?.holdAt ?? null,
        managedBy: null,
        source: existing?.source ?? null,
        review: existing?.review ?? null,
      },
    };
  }
  if (!existing?.clockedIn) return { action: "noop" };
  return { action: "close", at: now };
}

/** A shift that just opened is left alone so a slow Square search cannot clock them out. */
export const REMOTE_CLOSE_GRACE_MS = 20_000;

export function shouldCloseMissing(shift: ShiftLike, openTimecardIds: ReadonlySet<string>, at: number): boolean {
  if (!shift.clockedIn || !shift.timecardId) return false;
  if (openTimecardIds.has(shift.timecardId)) return false;
  if (shift.clockedInAt && at - shift.clockedInAt < REMOTE_CLOSE_GRACE_MS) return false;
  return true;
}

/**
 * Create a Square timecard only when this person has none open, locally or remotely.
 * A second call while the first card is open returns false.
 */
export function needsNewTimecard(input: {
  clockedIn: boolean;
  localTimecardId: string | null;
  remoteOpenIds: readonly string[];
}): boolean {
  if (input.remoteOpenIds.length > 0) return false;
  if (input.clockedIn && input.localTimecardId) return false;
  return true;
}

/** When several Square cards are open for one person, keep the earliest and do not open another. */
export function canonicalOpenId(ids: readonly { id: string; startedAt: number }[]): string | null {
  if (ids.length === 0) return null;
  return ids.slice().sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))[0].id;
}

export function autoCloseMoment(now: number, closeMin: number, tz: string): number {
  const key = zonedParts(now, tz).key;
  return shopDateStart(key, tz) + closeMin * 60_000;
}

/**
 * 7 PM close. A phone that is still on the clock, or held after a leave, ends at the auto-close minute.
 * A clock-in that itself starts after that minute stays open.
 */
export function dueAutoClose(input: {
  shift: Pick<ShiftLike, "clockedIn" | "clockedInAt" | "source" | "holdAt">;
  watch: WatchPerson | null;
  phase: DayPhase;
  now: number;
  autoCloseAt: number;
  quietMs: number;
}): number | null {
  if (!input.shift.clockedIn || input.shift.clockedInAt == null) return null;
  if (input.now < input.autoCloseAt) return null;
  if (input.shift.clockedInAt >= input.autoCloseAt) return null;
  const fromWatch = shouldAutoClose({
    phase: input.phase,
    clockInTs: input.shift.clockedInAt,
    watch: input.watch,
    now: input.now,
    autoCloseAt: input.autoCloseAt,
    quietMs: input.quietMs,
  });
  if (fromWatch != null) return fromWatch;
  const phone = input.shift.source === "phone-geo" || input.shift.source === "phone-wifi";
  if (phone || input.shift.holdAt != null) return input.autoCloseAt;
  return null;
}

/** Square labor webhook body. Wage amounts are ignored for writing; they only label an existing card. */
export function timecardFromWebhook(body: unknown): RemoteCard | null {
  if (!body || typeof body !== "object") return null;
  const type = (body as { type?: string }).type ?? "";
  if (!type.startsWith("labor.timecard.")) return null;
  const data = (body as { data?: { object?: { timecard?: SquareCard } & SquareCard } }).data;
  const card = data?.object?.timecard ?? (data?.object?.id ? (data.object as SquareCard) : undefined);
  if (!card?.id || !card.team_member_id) return null;
  const open = card.status ? card.status === "OPEN" : !card.end_at;
  const started = card.start_at ? Date.parse(card.start_at) : Date.now();
  return {
    personId: card.team_member_id,
    name: card.wage?.title || "Square",
    hourlyCents: card.wage?.hourly_rate?.amount ?? 0,
    timecardId: card.id,
    open,
    startedAt: Number.isFinite(started) ? started : Date.now(),
  };
}

type SquareCard = {
  id?: string;
  team_member_id?: string;
  start_at?: string;
  end_at?: string;
  status?: string;
  wage?: { title?: string; hourly_rate?: { amount?: number } };
};

/** Invoice ids already on the ledger are not counted again. */
export function ledgerKey(invoiceId: string, kind: "sent" | "paid"): string {
  return `${invoiceId}:${kind}`;
}

export function alreadyBooked(seen: ReadonlySet<string>, invoiceId: string, kind: "sent" | "paid"): boolean {
  return seen.has(ledgerKey(invoiceId, kind));
}

/** Block any Square call that would change a wage. Reading a wage setting is allowed. */
export function wageWriteBlocked(method: string, path: string): boolean {
  if (!/wage-setting/i.test(path)) return false;
  return method.toUpperCase() !== "GET";
}
