import type { DayPhase } from "../presence.ts";

export type WatchSource = {
  at: number;
  present: boolean;
  /** Phone automations stay present until an explicit leave. Heartbeats do not. */
  latch?: boolean;
};

export type WatchPerson = {
  lastSignalAt: number;
  lastSeenAt: number;
  sources: Record<string, WatchSource>;
};

export type SignalEvent = "enter" | "exit" | "seen";

export function normalizeEvent(raw: string): SignalEvent | null {
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (value === "enter" || value === "in" || value === "arrival") return "enter";
  if (value === "exit" || value === "out" || value === "leave" || value === "not_seen" || value === "absent" || value === "unseen") {
    return "exit";
  }
  if (value === "seen" || value === "present" || value === "heartbeat" || value === "here") return "seen";
  return null;
}

export function signalTimeDecision(
  ts: number,
  now: number,
  maxAgeMs: number,
  maxFutureMs: number,
): "ok" | "stale_signal" | "future_signal" | "bad_time" {
  if (!Number.isFinite(ts)) return "bad_time";
  if (ts - now > maxFutureMs) return "future_signal";
  if (now - ts > maxAgeMs) return "stale_signal";
  return "ok";
}

export function noteSight(
  current: WatchPerson | null,
  sight: { source: string; sourceId: string; at: number; present: boolean; latch?: boolean },
): WatchPerson {
  const base: WatchPerson = current ?? { lastSignalAt: 0, lastSeenAt: 0, sources: {} };
  const key = `${sight.source}:${sight.sourceId}`;
  const previous = base.sources[key];
  return {
    lastSignalAt: Math.max(base.lastSignalAt, sight.at),
    lastSeenAt: Math.max(base.lastSeenAt, sight.at),
    sources: {
      ...base.sources,
      [key]: { at: sight.at, present: sight.present, latch: sight.latch ?? previous?.latch ?? false },
    },
  };
}

/** A latched arrive holds the day. A heartbeat holds it only while it is fresh. */
export function holdsPresence(source: WatchSource, now: number, quietMs: number): boolean {
  if (!source.present) return false;
  if (source.latch) return true;
  return now - source.at < quietMs;
}

export function watchHolds(watch: WatchPerson | null, now: number, quietMs: number): boolean {
  if (!watch) return false;
  return Object.values(watch.sources).some((source) => holdsPresence(source, now, quietMs));
}

export function deviceLatched(watch: WatchPerson | null, deviceId: string, now: number, quietMs: number): boolean {
  if (!watch) return false;
  const prefix = `phone:${deviceId}:`;
  return Object.entries(watch.sources).some(([key, source]) => key.startsWith(prefix) && holdsPresence(source, now, quietMs));
}

export function dropPhoneLatches(watch: WatchPerson, deviceId: string, at: number): WatchPerson {
  let next = watch;
  const prefix = `phone:${deviceId}:`;
  for (const [key, source] of Object.entries(watch.sources)) {
    if (!key.startsWith(prefix) || !source.present) continue;
    next = noteSight(next, { source: "phone", sourceId: key.slice("phone:".length), at, present: false, latch: true });
  }
  return next;
}

/**
 * Leave time when every automated source has been silent for the quiet window.
 * The punch log's grace period still decides pending versus break.
 */
export function shouldQuietLeave(input: {
  phase: DayPhase;
  clockInTs: number | null;
  watch: WatchPerson | null;
  now: number;
  quietMs: number;
}): number | null {
  if (input.phase !== "working" || input.clockInTs == null || !input.watch) return null;
  if (input.watch.lastSignalAt < input.clockInTs) return null;
  if (input.watch.lastSeenAt < input.clockInTs) return null;
  if (watchHolds(input.watch, input.now, input.quietMs)) return null;
  if (input.now - input.watch.lastSignalAt < input.quietMs) return null;
  return Math.min(input.watch.lastSeenAt, input.now);
}

/**
 * Close a signal-tracked day that is still open after the auto-close minute.
 * A clock-in that itself starts after that minute stays open. Manual days
 * with no signal watch are left alone.
 */
export function shouldAutoClose(input: {
  phase: DayPhase;
  clockInTs: number | null;
  watch: WatchPerson | null;
  now: number;
  autoCloseAt: number;
  quietMs: number;
}): number | null {
  if (input.phase !== "working" || input.clockInTs == null || !input.watch) return null;
  if (input.now < input.autoCloseAt) return null;
  if (input.clockInTs >= input.autoCloseAt) return null;
  if (watchHolds(input.watch, input.now, input.quietMs)) return input.autoCloseAt;
  if (input.watch.lastSeenAt < input.clockInTs) return null;
  return Math.min(Math.max(input.watch.lastSeenAt, input.clockInTs), input.now);
}
