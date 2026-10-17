import { SHOP_PRESENCE } from "@shared/presence";

const EARTH_RADIUS_M = 6_371_000;

/** Building centroid for 403 E Ben White Blvd. The browser never receives this. */
export const SHOP_POINT = {
  lat: 30.219778,
  lng: -97.760707,
  radiusM: 120,
  maxAccuracyM: 75,
  maxAgeMs: 30_000,
  maxFutureMs: 15_000,
} as const;

export type FenceConfig = {
  lat: number;
  lng: number;
  radiusM: number;
  maxAccuracyM: number;
  maxAgeMs: number;
  maxFutureMs: number;
};

export type FixDecision = {
  accepted: boolean;
  distanceM: number;
  reason: "outside_fence" | "low_accuracy" | "stale_fix" | "future_fix" | "missing_fix" | null;
};

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const sinLat = Math.sin(Δφ / 2);
  const sinLng = Math.sin(Δλ / 2);
  const h = sinLat * sinLat + Math.cos(φ1) * Math.cos(φ2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function fenceFromEnv(env: NodeJS.ProcessEnv = process.env): FenceConfig {
  const radiusM = readNumber(env.GEO_FENCE_RADIUS_M, SHOP_POINT.radiusM);
  const maxAccuracyM = readNumber(env.GEO_FENCE_MAX_ACCURACY_M, SHOP_POINT.maxAccuracyM);
  const maxAgeMs = readNumber(env.GEO_FENCE_MAX_AGE_MS, SHOP_POINT.maxAgeMs);
  const maxFutureMs = readNumber(env.GEO_FENCE_MAX_FUTURE_MS, SHOP_POINT.maxFutureMs);
  return {
    lat: readNumber(env.GEO_FENCE_LAT, SHOP_POINT.lat),
    lng: readNumber(env.GEO_FENCE_LNG, SHOP_POINT.lng),
    radiusM: radiusM > 0 ? radiusM : SHOP_POINT.radiusM,
    maxAccuracyM: maxAccuracyM > 0 ? maxAccuracyM : SHOP_POINT.maxAccuracyM,
    maxAgeMs: maxAgeMs > 0 ? maxAgeMs : SHOP_POINT.maxAgeMs,
    maxFutureMs: maxFutureMs >= 0 ? maxFutureMs : SHOP_POINT.maxFutureMs,
  };
}

function coordsOk(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function judgeFix(
  fix: { lat: number; lng: number; accuracy: number; capturedAt: number } | null,
  fence: FenceConfig,
  now: number,
): FixDecision {
  if (!fix || !coordsOk(fix.lat, fix.lng) || !Number.isFinite(fix.capturedAt) || !Number.isFinite(fix.accuracy)) {
    return { accepted: false, distanceM: 0, reason: "missing_fix" };
  }
  const distanceM = Math.round(distanceMeters(fix.lat, fix.lng, fence.lat, fence.lng) * 10) / 10;
  if (fix.accuracy <= 0 || fix.accuracy > fence.maxAccuracyM) {
    return { accepted: false, distanceM, reason: "low_accuracy" };
  }
  const skew = fix.capturedAt - now;
  if (skew > fence.maxFutureMs) return { accepted: false, distanceM, reason: "future_fix" };
  if (now - fix.capturedAt > fence.maxAgeMs) return { accepted: false, distanceM, reason: "stale_fix" };
  if (distanceM > fence.radiusM) return { accepted: false, distanceM, reason: "outside_fence" };
  return { accepted: true, distanceM, reason: null };
}

export function shopLabel(): { label: string; address: string } {
  return { label: SHOP_PRESENCE.label, address: SHOP_PRESENCE.address };
}
