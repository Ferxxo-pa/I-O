import assert from "node:assert/strict";
import { timecardCloseBody, timecardCreateBody, timecardFromWebhook } from "./square/labor.ts";

const created = timecardCreateBody({
  locationId: "L1",
  teamMemberId: "TM1",
  startAt: "2026-01-01T00:00:00.000Z",
  hourlyCents: 3200,
  idempotencyKey: "key",
});
assert.equal(created.idempotency_key, "key");
assert.equal(created.timecard.location_id, "L1");
assert.equal(created.timecard.team_member_id, "TM1");
assert.equal(created.timecard.start_at, "2026-01-01T00:00:00.000Z");
assert.equal(created.timecard.wage.hourly_rate.amount, 3200);
assert.equal(created.timecard.wage.hourly_rate.currency, "USD");

const closed = timecardCloseBody(
  {
    team_member_id: "TM1",
    location_id: "L1",
    start_at: "2026-01-01T00:00:00.000Z",
    version: 3,
    wage: { title: "Hourly", hourly_rate: { amount: 3200, currency: "USD" } },
  },
  "2026-01-01T01:00:00.000Z",
);
assert.equal(closed.timecard.status, "CLOSED");
assert.equal(closed.timecard.end_at, "2026-01-01T01:00:00.000Z");
assert.equal(closed.timecard.version, 3);

const remote = timecardFromWebhook({
  type: "labor.timecard.created",
  data: {
    object: {
      timecard: {
        id: "card",
        team_member_id: "TM9",
        start_at: "2026-01-01T00:00:00.000Z",
        status: "OPEN",
        wage: { title: "Bar", hourly_rate: { amount: 1800 } },
      },
    },
  },
});
assert.equal(remote?.personId, "TM9");
assert.equal(remote?.name, "Bar");
assert.equal(remote?.hourlyCents, 1800);
assert.equal(remote?.open, true);
assert.equal(remote?.timecardId, "card");
assert.equal(timecardFromWebhook({ type: "invoice.payment_made" }), null);
assert.equal(timecardFromWebhook(null), null);

console.log("labor ok");
