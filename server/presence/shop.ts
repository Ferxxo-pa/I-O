import type { DayConfig } from "@shared/presence";
import { getCompany } from "../company";
import { dayConfigFromEnv, signalConfigFromEnv, type SignalConfig } from "./config";
import { fenceFromEnv, type FenceConfig } from "./geo";

/** The company id is the team id. Blank until the first save mints one. */
export function shopTeamId(): string {
  return getCompany().id || "";
}

export function shopDayConfig(env: NodeJS.ProcessEnv = process.env): DayConfig {
  const base = dayConfigFromEnv(env);
  const shop = getCompany().shop;
  return {
    ...base,
    normalOpenMin: shop?.openMin ?? base.normalOpenMin,
    normalCloseMin: shop?.closeMin ?? base.normalCloseMin,
  };
}

export function shopSignalConfig(env: NodeJS.ProcessEnv = process.env): SignalConfig {
  const base = signalConfigFromEnv(env);
  const shop = getCompany().shop;
  return {
    ...base,
    quietMs: shop?.graceMs ?? base.quietMs,
    autoCloseMin: shop?.autoCloseMin ?? base.autoCloseMin,
  };
}

export function shopFence(env: NodeJS.ProcessEnv = process.env): FenceConfig {
  const base = fenceFromEnv(env);
  const shop = getCompany().shop;
  if (shop?.fenceLat == null || shop.fenceLng == null || shop.fenceRadiusM == null) return base;
  return { ...base, lat: shop.fenceLat, lng: shop.fenceLng, radiusM: shop.fenceRadiusM };
}

/** A saved device with no team id belongs to this company. A different id does not. */
export function deviceOnThisTeam(teamId: string | null | undefined): boolean {
  const home = shopTeamId();
  if (!teamId) return true;
  if (!home) return true;
  return teamId === home;
}
