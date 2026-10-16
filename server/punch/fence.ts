import { SHOP_CLOCK, type GeoFix, type PunchReason } from "@shared/punch";

const EARTH_RADIUS_M = 6_371_000;

export type FenceConfig = {
  lat: number;
  lng: number;
  radiusM: number;
  maxAccuracyM: number;
  maxAgeMs: number;
  maxFutureSkewMs: number;
};

export type FenceDecision = {
  accepted: boolean;
  distanceM: number;
  reason: PunchReason | null;
};

/** Great-circle distance in meters. */
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
  const radiusM = readNumber(env.GEO_FENCE_RADIUS_M, SHOP_CLOCK.radiusM);
  const maxAccuracyM = readNumber(env.GEO_FENCE_MAX_ACCURACY_M, SHOP_CLOCK.maxAccuracyM);
  const maxAgeMs = readNumber(env.GEO_FENCE_MAX_AGE_MS, SHOP_CLOCK.maxAgeMs);
  const maxFutureSkewMs = readNumber(env.GEO_FENCE_MAX_FUTURE_MS, SHOP_CLOCK.maxFutureSkewMs);
  return {
    lat: readNumber(env.GEO_FENCE_LAT, SHOP_CLOCK.lat),
    lng: readNumber(env.GEO_FENCE_LNG, SHOP_CLOCK.lng),
    radiusM: radiusM > 0 ? radiusM : SHOP_CLOCK.radiusM,
    maxAccuracyM: maxAccuracyM > 0 ? maxAccuracyM : SHOP_CLOCK.maxAccuracyM,
    maxAgeMs: maxAgeMs > 0 ? maxAgeMs : SHOP_CLOCK.maxAgeMs,
    maxFutureSkewMs: maxFutureSkewMs >= 0 ? maxFutureSkewMs : SHOP_CLOCK.maxFutureSkewMs,
  };
}

function coordsOk(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function roundMeters(meters: number): number {
  return Math.round(meters * 10) / 10;
}

/**
 * Server-side fence. Accuracy and timestamp are checked before the radius
 * so a spoofed or stale reading is not treated as a real "outside" position.
 */
export function judgeFix(fix: GeoFix | null | undefined, fence: FenceConfig, now: number): FenceDecision {
  if (!fix || !coordsOk(fix.lat, fix.lng) || !Number.isFinite(fix.capturedAt)) {
    return { accepted: false, distanceM: 0, reason: "missing_fix" };
  }

  const distanceM = roundMeters(distanceMeters(fix.lat, fix.lng, fence.lat, fence.lng));
  const accuracy = fix.accuracyM;
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > fence.maxAccuracyM) {
    return { accepted: false, distanceM, reason: "low_accuracy" };
  }

  const skew = fix.capturedAt - now;
  if (skew > fence.maxFutureSkewMs) {
    return { accepted: false, distanceM, reason: "future_fix" };
  }
  if (now - fix.capturedAt > fence.maxAgeMs) {
    return { accepted: false, distanceM, reason: "stale_fix" };
  }
  if (distanceM > fence.radiusM) {
    return { accepted: false, distanceM, reason: "outside_fence" };
  }
  return { accepted: true, distanceM, reason: null };
}
