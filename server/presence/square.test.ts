import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DAY, deriveDay, shopDateStart, type DayConfig } from "@shared/presence.ts";
import {
  applyStep,
  assertPresenceDoesNotWritePay,
  blankLink,
  mirrorMode,
  nextMirrorStep,
  planCall,
  presenceOpenBody,
  runMirrorStep,
  type SquarePerson,
} from "./square.ts";

const config: DayConfig = { ...DEFAULT_DAY, openWeekdays: [...DEFAULT_DAY.openWeekdays] };
const start = shopDateStart("2026-10-14");
const at = (hours: number, minutes = 0) => start + (hours * 60 + minutes) * 60_000;
const square: SquarePerson = {
  personId: "ada",
  teamMemberId: "TM_ADA",
  jobId: "JOB_ADA",
  lunchBreakTypeId: "BR_LUNCH",
  shortBreakTypeId: "BR_SHORT",
};

const openBody = presenceOpenBody({
  locationId: "L1",
  teamMemberId: square.teamMemberId,
  jobId: square.jobId,
  startAt: new Date(at(9)).toISOString(),
  idempotencyKey: "key",
});
assert.equal(openBody.timecard.team_member_id, "TM_ADA");
assert.deepEqual(openBody.timecard.wage, { job_id: "JOB_ADA" });
assert.equal(JSON.stringify(openBody).includes("hourly_rate"), false);
assert.equal(JSON.stringify(openBody).includes("amount"), false);
assert.doesNotThrow(() => assertPresenceDoesNotWritePay("/v2/labor/timecards", openBody));
assert.throws(
  () => assertPresenceDoesNotWritePay("/v2/team-members/TM_ADA/wage-setting", {}),
  /never changes pay settings/,
);
assert.throws(
  () =>
    assertPresenceDoesNotWritePay("/v2/labor/timecards", {
      timecard: { wage: { hourly_rate: { amount: 2000, currency: "USD" } } },
    }),
  /never writes a wage/,
);

delete process.env.SQUARE_PRESENCE_MIRROR;
delete process.env.SQUARE_ACCESS_TOKEN;
assert.equal(mirrorMode(), "dry_run");
assert.equal(mirrorMode({ SQUARE_PRESENCE_MIRROR: "live" }), "dry_run");
assert.equal(mirrorMode({ SQUARE_PRESENCE_MIRROR: "live", SQUARE_ACCESS_TOKEN: "sq0" }), "live");
assert.equal(mirrorMode({ SQUARE_PRESENCE_MIRROR: "dry", SQUARE_ACCESS_TOKEN: "sq0" }), "dry_run");

const working = deriveDay([{ type: "arrive", ts: at(9) }], config, at(9, 5));
let link = blankLink("ada", working.date);
const open = nextMirrorStep(working, link, square, "L1");
assert.equal(open?.op, "open");
if (open?.op !== "open") throw new Error("expected open");
let calls = 0;
const dry = await runMirrorStep(open, link, {
  mode: "dry_run",
  request: async () => {
    calls += 1;
    return {};
  },
});
assert.equal(calls, 0);
assert.equal(dry.link.timecardId, "dry_ada_" + working.date);
assert.equal(JSON.stringify(dry.planned.body).includes("hourly_rate"), false);
assert.equal(JSON.stringify(dry.planned.body).includes("TM_ADA"), true);
link = dry.link;

const lunch = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(11, 30) },
  ],
  config,
  at(11, 50),
);
const started = nextMirrorStep(lunch, link, square, "L1");
assert.equal(started?.op, "start_break");
if (started?.op !== "start_break") throw new Error("expected break");
assert.equal(started.breakTypeId, "BR_LUNCH");
assert.equal(started.name, "Lunch");
assert.equal(started.endAt, null);
const plannedBreak = planCall(started, link, "key");
assert.equal(JSON.stringify(plannedBreak.body).includes("hourly"), false);
assert.equal(JSON.stringify(plannedBreak.body).includes("is_paid\":false"), true);
link = applyStep(link, started);

const returned = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(11, 30) },
    { type: "arrive", ts: at(12) },
  ],
  config,
  at(12, 10),
);
const ended = nextMirrorStep(returned, link, square, "L1");
assert.equal(ended?.op, "end_break");
if (!ended) throw new Error("expected end");
link = applyStep(link, ended);

const closed = deriveDay(
  [
    { type: "arrive", ts: at(9) },
    { type: "leave", ts: at(11, 30) },
    { type: "arrive", ts: at(12) },
    { type: "leave", ts: at(16) },
  ],
  config,
  at(19),
);
const closing = nextMirrorStep(closed, link, square, "L1");
assert.equal(closing?.op, "close");
if (closing?.op !== "close") throw new Error("expected close");
assert.equal(closing.endAt, new Date(at(16)).toISOString());
const closePlan = planCall(closing, link, "key");
assert.equal(JSON.stringify(closePlan.body).includes("hourly_rate"), false);
assert.equal(JSON.stringify(closePlan.body).includes("CLOSED"), true);

const fetchedWage = { title: "Print", hourly_rate: { amount: 3200, currency: "USD" } };
let putBody = "";
await runMirrorStep(open, blankLink("ada", working.date), {
  mode: "live",
  request: async (path, method, body) => {
    if (method === "POST") {
      assert.equal(JSON.stringify(body).includes("hourly_rate"), false);
      return { timecard: { id: "card-1" } };
    }
    if (method === "GET") {
      return {
        timecard: {
          id: "card-1",
          version: 2,
          team_member_id: "TM_ADA",
          location_id: "L1",
          start_at: open.startAt,
          wage: fetchedWage,
          breaks: [],
        },
      };
    }
    putBody = JSON.stringify(body);
    assert.equal(path.includes("wage-setting"), false);
    return { timecard: { id: "card-1" } };
  },
});
const withBreak = await runMirrorStep(started, { ...link, timecardId: "card-1", breaksStarted: 0, openBreak: false }, {
  mode: "live",
  request: async (_path, method, body) => {
    if (method === "GET") {
      return {
        timecard: {
          version: 3,
          team_member_id: "TM_ADA",
          location_id: "L1",
          start_at: open.startAt,
          wage: fetchedWage,
          breaks: [],
        },
      };
    }
    const sent = body as { timecard: { wage?: typeof fetchedWage; breaks?: Array<{ is_paid?: boolean }> } };
    assert.equal(sent.timecard.wage, fetchedWage);
    assert.equal(sent.timecard.breaks?.[0]?.is_paid, false);
    return {};
  },
});
assert.equal(withBreak.link.openBreak, true);
assert.equal(putBody.includes("wage-setting"), false);

function clientSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return clientSource(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [readFileSync(path, "utf8")] : [];
  });
}

const client = clientSource(join(process.cwd(), "client/src")).join("\n");
assert.equal(client.includes("SQUARE_ACCESS_TOKEN"), false);
assert.equal(client.includes("PRESENCE_DESK_TOKEN"), false);
assert.equal(client.includes("30.219778"), false);
assert.equal(client.includes("wage-setting"), false);

console.log("presence square ok");
