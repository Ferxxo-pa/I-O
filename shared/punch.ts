import { z } from "zod";

/**
 * Shop clock for EZ Designs, 403 E Ben White Blvd, Austin.
 * The default point is the OpenStreetMap building centroid.
 * Env can move the fence; the client never receives the center.
 */
export const SHOP_CLOCK = {
  label: "EZ Designs",
  address: "403 E Ben White Blvd, Austin, TX",
  lat: 30.219778,
  lng: -97.760707,
  radiusM: 120,
  maxAccuracyM: 75,
  maxAgeMs: 30_000,
  maxFutureSkewMs: 15_000,
} as const;

export const punchActionSchema = z.enum(["in", "out"]);
export type PunchAction = z.infer<typeof punchActionSchema>;

export const punchReasonSchema = z.enum([
  "outside_fence",
  "low_accuracy",
  "stale_fix",
  "future_fix",
  "missing_fix",
  "already_clocked_in",
  "not_clocked_in",
  "square_failed",
]);
export type PunchReason = z.infer<typeof punchReasonSchema>;

export const PUNCH_REASON_TEXT: Record<PunchReason, string> = {
  outside_fence: "Outside the shop",
  low_accuracy: "Location isn't accurate enough",
  stale_fix: "Location reading is too old",
  future_fix: "Location time doesn't match",
  missing_fix: "No location reading",
  already_clocked_in: "Already clocked in",
  not_clocked_in: "Clock in before clocking out",
  square_failed: "Square didn't record the punch",
};

export function punchReasonText(reason: PunchReason | null): string | null {
  if (!reason) return null;
  return PUNCH_REASON_TEXT[reason];
}

export const geoFixSchema = z.object({
  lat: z.number().finite(),
  lng: z.number().finite(),
  accuracyM: z.number().finite(),
  capturedAt: z.number().finite(),
});
export type GeoFix = z.infer<typeof geoFixSchema>;

export const punchRecordSchema = z.object({
  id: z.string(),
  personId: z.string(),
  personName: z.string(),
  action: punchActionSchema,
  at: z.number(),
  capturedAt: z.number(),
  lat: z.number(),
  lng: z.number(),
  accuracyM: z.number(),
  distanceM: z.number(),
  accepted: z.boolean(),
  reason: punchReasonSchema.nullable(),
  source: z.enum(["local", "square"]),
  timecardId: z.string().nullable(),
});
export type PunchRecord = z.infer<typeof punchRecordSchema>;

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  const body = km >= 10 ? String(Math.round(km)) : km.toFixed(1);
  return `${body} km`;
}
