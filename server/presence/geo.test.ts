import assert from "node:assert/strict";
import { SHOP_POINT, distanceMeters, fenceFromEnv, judgeFix } from "./geo.ts";

const fence = fenceFromEnv({});
assert.equal(fence.lat, SHOP_POINT.lat);
assert.equal(fence.lng, SHOP_POINT.lng);
assert.equal(fence.maxAccuracyM, 75);
assert.equal(fence.maxAgeMs, 30_000);
assert.equal(fenceFromEnv({ GEO_FENCE_LAT: "nope" }).lat, SHOP_POINT.lat);

const now = 1_700_000_000_000;
const here = { lat: fence.lat, lng: fence.lng, accuracy: 12, capturedAt: now };
const inside = judgeFix(here, fence, now);
assert.equal(inside.accepted, true);
assert.equal(inside.distanceM, 0);

const outside = judgeFix({ ...here, lat: fence.lat + 0.01 }, fence, now);
assert.equal(outside.accepted, false);
assert.equal(outside.reason, "outside_fence");
assert.ok(outside.distanceM > fence.radiusM);
assert.ok(distanceMeters(fence.lat, fence.lng, fence.lat + 0.01, fence.lng) > 120);

assert.equal(judgeFix({ ...here, accuracy: 75 }, fence, now).accepted, true);
assert.equal(judgeFix({ ...here, accuracy: 75.1 }, fence, now).reason, "low_accuracy");
assert.equal(judgeFix({ ...here, accuracy: 0 }, fence, now).reason, "low_accuracy");
assert.equal(judgeFix({ ...here, capturedAt: now - 30_000 }, fence, now).accepted, true);
assert.equal(judgeFix({ ...here, capturedAt: now - 30_001 }, fence, now).reason, "stale_fix");
assert.equal(judgeFix({ ...here, capturedAt: now + 15_000 }, fence, now).accepted, true);
assert.equal(judgeFix({ ...here, capturedAt: now + 15_001 }, fence, now).reason, "future_fix");
assert.equal(judgeFix(null, fence, now).reason, "missing_fix");

console.log("presence geo ok");
