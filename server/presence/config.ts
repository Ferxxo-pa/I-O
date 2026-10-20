import { DEFAULT_DAY, SHOP_PRESENCE, type DayConfig } from "@shared/presence";

function minutes(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return hour * 60 + minute;
}

function whole(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function shopPeople(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** Positive minutes, or null when the shop day has no minute gate. */
function shopMinutes(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function dayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DayConfig {
  const open = (env.PRESENCE_OPEN_WEEKDAYS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return {
    arriveStartMin: minutes(env.PRESENCE_ARRIVE_START, DEFAULT_DAY.arriveStartMin),
    arriveEndMin: minutes(env.PRESENCE_ARRIVE_END, DEFAULT_DAY.arriveEndMin),
    lunchStartMin: minutes(env.PRESENCE_LUNCH_START, DEFAULT_DAY.lunchStartMin),
    lunchEndMin: minutes(env.PRESENCE_LUNCH_END, DEFAULT_DAY.lunchEndMin),
    minAwayMs: whole(env.PRESENCE_MIN_AWAY_MS, DEFAULT_DAY.minAwayMs) || DEFAULT_DAY.minAwayMs,
    normalOpenMin: minutes(env.PRESENCE_OPEN, DEFAULT_DAY.normalOpenMin),
    normalCloseMin: minutes(env.PRESENCE_CLOSE, DEFAULT_DAY.normalCloseMin),
    dayCloseMin: minutes(env.PRESENCE_DAY_CLOSE, DEFAULT_DAY.dayCloseMin),
    closeGraceMs: whole(env.PRESENCE_CLOSE_GRACE_MS, DEFAULT_DAY.closeGraceMs),
    openWeekdays: open.length > 0 ? open : [...DEFAULT_DAY.openWeekdays],
    tz: env.PRESENCE_TZ?.trim() === SHOP_PRESENCE.tz ? SHOP_PRESENCE.tz : DEFAULT_DAY.tz,
    shopDayMinPeople: shopPeople(env.PRESENCE_SHOP_DAY_MIN_PEOPLE, DEFAULT_DAY.shopDayMinPeople),
    shopDayMinMinutes: shopMinutes(env.PRESENCE_SHOP_DAY_MIN_MINUTES),
  };
}

export type SignalConfig = {
  /** No trusted signal for this long starts a leave. Default 15 minutes. */
  quietMs: number;
  /** Local minute-of-day after which an open signal day is closed. Default 7:00 PM. */
  autoCloseMin: number;
  /** Reject signal timestamps older than this. Default 2 minutes. */
  maxAgeMs: number;
  /** Reject signal timestamps further ahead than this. Default 15 seconds. */
  maxFutureMs: number;
  /** Accepted and rejected signals per IP per minute. */
  ratePerMin: number;
  /** BLE is off until the owner turns the stub on. */
  bleEnabled: boolean;
  /** How far before open and after close automatic signals are accepted. Default 2 hours. */
  collectMarginMs: number;
  /** Continuous sightings longer than this stop driving presence. Default 14 hours. */
  stationaryMs: number;
  /** Seen this close to both ends of the collection window counts as overnight. */
  overnightEdgeMs: number;
  /** Phone automations may arrive a few minutes late. Default 10 minutes. */
  phoneMaxAgeMs: number;
  /** Same phone event inside this window is a retry, not a second punch. Default 2 minutes. */
  phoneDedupeMs: number;
};

function positive(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function signalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SignalConfig {
  return {
    quietMs: positive(env.PRESENCE_SIGNAL_QUIET_MS, 15 * 60 * 1000),
    autoCloseMin: minutes(env.PRESENCE_AUTO_CLOSE, 19 * 60),
    maxAgeMs: positive(env.PRESENCE_SIGNAL_MAX_AGE_MS, 120_000),
    maxFutureMs: nonNegative(env.PRESENCE_SIGNAL_MAX_FUTURE_MS, 15_000),
    ratePerMin: positiveInt(env.PRESENCE_SIGNAL_RATE_PER_MIN, 60),
    bleEnabled: /^(1|true|on|yes)$/i.test(env.PRESENCE_BLE_ENABLED?.trim() ?? ""),
    collectMarginMs: positive(env.PRESENCE_COLLECT_MARGIN_MS, 2 * 60 * 60 * 1000),
    stationaryMs: positive(env.PRESENCE_STATIONARY_MS, 14 * 60 * 60 * 1000),
    overnightEdgeMs: nonNegative(env.PRESENCE_OVERNIGHT_EDGE_MS, 30 * 60 * 1000),
    phoneMaxAgeMs: positive(env.PRESENCE_PHONE_MAX_AGE_MS, 10 * 60 * 1000),
    phoneDedupeMs: positive(env.PRESENCE_PHONE_DEDUPE_MS, 2 * 60 * 1000),
  };
}

export function wifiHmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.PRESENCE_WIFI_HMAC_SECRET?.trim() ?? "";
}

export function bleHmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.PRESENCE_BLE_HMAC_SECRET?.trim() ?? "";
}
