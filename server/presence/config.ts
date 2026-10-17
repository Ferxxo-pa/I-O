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
  };
}
