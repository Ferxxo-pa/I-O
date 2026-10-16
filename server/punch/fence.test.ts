import assert from "node:assert/strict";
import { SHOP_CLOCK } from "@shared/punch";
import { distanceMeters, fenceFromEnv, judgeFix, type FenceConfig } from "./fence.ts";

const oneDegreeNorth = distanceMeters(0, 0, 1, 0);
assert.ok(Math.abs(oneDegreeNorth - 111_194.93) < 1, `expected ~111195 m, got ${oneDegreeNorth}`);
assert.ok(distanceMeters(SHOP_CLOCK.lat, SHOP_CLOCK.lng, SHOP_CLOCK.lat, SHOP_CLOCK.lng) < 0.001);

const defaults = fenceFromEnv({});
assert.equal(defaults.lat, SHOP_CLOCK.lat);
assert.equal(defaults.lng, SHOP_CLOCK.lng);
assert.equal(defaults.radiusM, 120);
assert.equal(defaults.maxAccuracyM, 75);
assert.equal(fenceFromEnv({ GEO_FENCE_LAT: "nope" }).lat, SHOP_CLOCK.lat);
assert.equal(fenceFromEnv({ GEO_FENCE_RADIUS_M: "80" }).radiusM, 80);

const fence: FenceConfig = {
  lat: SHOP_CLOCK.lat,
  lng: SHOP_CLOCK.lng,
  radiusM: 100,
  maxAccuracyM: 50,
  maxAgeMs: 30_000,
  maxFutureSkewMs: 15_000,
};
const now = 1_700_000_000_000;

function fix(patch: Partial<{ lat: number; lng: number; accuracyM: number; capturedAt: number }> = {}) {
  return {
    lat: fence.lat,
    lng: fence.lng,
    accuracyM: 12,
    capturedAt: now,
    ...patch,
  };
}

const inside = judgeFix(fix(), fence, now);
assert.equal(inside.accepted, true);
assert.equal(inside.reason, null);
assert.equal(inside.distanceM, 0);

const north = judgeFix(fix({ lat: fence.lat + 1 }), fence, now);
assert.equal(north.accepted, false);
assert.equal(north.reason, "outside_fence");
assert.ok(north.distanceM > fence.radiusM);

const sloppy = judgeFix(fix({ lat: fence.lat + 1, accuracyM: 500 }), fence, now);
assert.equal(sloppy.reason, "low_accuracy");
assert.ok(sloppy.distanceM > fence.radiusM);

assert.equal(judgeFix(fix({ accuracyM: 0 }), fence, now).reason, "low_accuracy");
assert.equal(judgeFix(fix({ accuracyM: -5 }), fence, now).reason, "low_accuracy");
assert.equal(judgeFix(fix({ accuracyM: 50 }), fence, now).accepted, true);
assert.equal(judgeFix(fix({ accuracyM: 50.1 }), fence, now).reason, "low_accuracy");

assert.equal(judgeFix(fix({ capturedAt: now - 30_000 }), fence, now).accepted, true);
assert.equal(judgeFix(fix({ capturedAt: now - 30_001 }), fence, now).reason, "stale_fix");
assert.equal(judgeFix(fix({ capturedAt: now + 15_000 }), fence, now).accepted, true);
assert.equal(judgeFix(fix({ capturedAt: now + 15_001 }), fence, now).reason, "future_fix");

assert.equal(judgeFix(null, fence, now).reason, "missing_fix");
assert.equal(judgeFix(fix({ lat: 120 }), fence, now).reason, "missing_fix");
assert.equal(judgeFix(fix({ lng: 200 }), fence, now).reason, "missing_fix");

const edge = judgeFix(fix(), { ...fence, radiusM: 0 }, now);
assert.equal(edge.accepted, true, "standing on the shop point is inside a zero radius");

console.log("fence ok");
