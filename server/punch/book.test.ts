import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHOP_CLOCK } from "@shared/punch";
import { PunchBook } from "./book.ts";
import type { FenceConfig } from "./fence.ts";
import { appendPunchLog, readPunchLog } from "./log.ts";
import { createPunchSink, punchSinkMode, type PunchSink } from "./sink.ts";
import { writePinFile } from "./service.ts";
import {
  assertPunchDoesNotWritePay,
  punchTimecardCloseBody,
  punchTimecardCreateBody,
} from "./square.ts";

const fence: FenceConfig = {
  lat: SHOP_CLOCK.lat,
  lng: SHOP_CLOCK.lng,
  radiusM: 120,
  maxAccuracyM: 75,
  maxAgeMs: 30_000,
  maxFutureSkewMs: 15_000,
};
const now = 1_700_000_000_000;
const ada = { id: "ada", name: "Ada" };
const inside = { lat: fence.lat, lng: fence.lng, accuracyM: 15, capturedAt: now };
const outside = { lat: fence.lat + 0.05, lng: fence.lng, accuracyM: 15, capturedAt: now };

function memorySink(): PunchSink & { ins: number; outs: number } {
  let n = 0;
  return {
    mode: "local",
    ins: 0,
    outs: 0,
    async clockIn() {
      this.ins += 1;
      n += 1;
      return { timecardId: `local_test_${n}` };
    },
    async clockOut() {
      this.outs += 1;
    },
  };
}

function bookWith(sink: PunchSink, records: ReturnType<PunchBook["list"]> = []) {
  const persisted = records.slice().reverse();
  const book = new PunchBook({
    fence,
    sink,
    now: () => now,
    records: persisted,
    append: (row) => persisted.push(row),
  });
  return { book, persisted };
}

const sink = memorySink();
const { book, persisted } = bookWith(sink);

const opened = await book.punch(ada, "in", inside);
assert.equal(opened.accepted, true);
assert.equal(opened.reason, null);
assert.equal(opened.distanceM, 0);
assert.equal(opened.personName, "Ada");
assert.equal(opened.source, "local");
assert.match(opened.timecardId ?? "", /^local_test_/);
assert.equal(book.status("ada").clockedIn, true);
assert.equal(sink.ins, 1);

const doubled = await book.punch(ada, "in", inside);
assert.equal(doubled.accepted, false);
assert.equal(doubled.reason, "already_clocked_in");
assert.equal(doubled.timecardId, null);
assert.equal(book.status("ada").clockedIn, true);
assert.equal(sink.ins, 1, "a second clock-in must not open another timecard");

const away = await book.punch(ada, "out", outside);
assert.equal(away.accepted, false);
assert.equal(away.reason, "outside_fence");
assert.ok(away.distanceM > fence.radiusM);
assert.equal(book.status("ada").clockedIn, true);
assert.equal(sink.outs, 0, "a rejected clock-out must leave the shift open");

const closed = await book.punch(ada, "out", inside);
assert.equal(closed.accepted, true);
assert.equal(book.status("ada").clockedIn, false);
assert.equal(sink.outs, 1);

const orphan = await book.punch(ada, "out", inside);
assert.equal(orphan.accepted, false);
assert.equal(orphan.reason, "not_clocked_in");
assert.equal(sink.outs, 1, "clock-out with no open shift must not call the sink");
assert.equal(book.status("ada").clockedIn, false);

const low = await book.punch(ada, "in", { ...inside, accuracyM: 400 });
assert.equal(low.accepted, false);
assert.equal(low.reason, "low_accuracy");
const stale = await book.punch(ada, "in", { ...inside, capturedAt: now - 60_000 });
assert.equal(stale.reason, "stale_fix");
const future = await book.punch(ada, "in", { ...inside, capturedAt: now + 60_000 });
assert.equal(future.reason, "future_fix");
assert.equal(book.status("ada").clockedIn, false);
assert.equal(sink.ins, 1);

const restored = new PunchBook({
  fence,
  sink: memorySink(),
  now: () => now,
  records: persisted,
  append: () => {
    throw new Error("replay should not write");
  },
});
assert.equal(restored.status("ada").clockedIn, false);
const reopen = await book.punch(ada, "in", inside);
assert.equal(reopen.accepted, true);
const replayed = new PunchBook({
  fence,
  sink: memorySink(),
  now: () => now,
  records: persisted,
  append: (row) => persisted.push(row),
});
assert.equal(replayed.status("ada").clockedIn, true);
assert.equal(replayed.status("ada").clockedInAt, now);

let squareIns = 0;
const squareSink: PunchSink = {
  mode: "square",
  async clockIn() {
    squareIns += 1;
    throw new Error("Square is down");
  },
  async clockOut() {
    throw new Error("no");
  },
};
const squareBook = new PunchBook({
  fence,
  sink: squareSink,
  now: () => now,
  records: [],
  append: () => {},
});
const failed = await squareBook.punch(ada, "in", inside);
assert.equal(failed.accepted, false);
assert.equal(failed.reason, "square_failed");
assert.equal(squareBook.status("ada").clockedIn, false);
assert.equal(squareIns, 1);

const dir = mkdtempSync(join(tmpdir(), "io-punches-"));
const file = join(dir, "punches.jsonl");
writeFileSync(file, "{not json}\n");
appendPunchLog(file, opened);
const before = readFileSync(file, "utf8");
appendPunchLog(file, doubled);
const after = readFileSync(file, "utf8");
assert.equal(after.startsWith(before), true, "new punches are appended after the old lines");
assert.equal(before.split("\n").filter(Boolean).length, 2);
const loaded = readPunchLog(file);
assert.equal(loaded.length, 2);
assert.equal(loaded[0].id, opened.id);
assert.equal(loaded[1].reason, "already_clocked_in");
assert.equal(after.includes("{not json}"), true, "a bad line stays in the file");

const pinFileHash = writePinFile(dir, "2468");
const pinBody = readFileSync(join(dir, "punch-pin.json"), "utf8");
assert.equal(pinBody.includes("2468"), false);
assert.equal(pinBody.includes(pinFileHash), true);

delete process.env.SQUARE_LABOR_PUNCHES;
delete process.env.SQUARE_ACCESS_TOKEN;
assert.equal(punchSinkMode(), "local");
assert.equal(createPunchSink().mode, "local");
assert.equal(punchSinkMode({ SQUARE_LABOR_PUNCHES: "1" }), "local");
assert.equal(punchSinkMode({ SQUARE_LABOR_PUNCHES: "true", SQUARE_ACCESS_TOKEN: "sq0" }), "square");
assert.equal(punchSinkMode({ SQUARE_LABOR_PUNCHES: "on", SQUARE_ACCESS_TOKEN: "sq0" }), "square");
assert.equal(punchSinkMode({ SQUARE_LABOR_PUNCHES: "0", SQUARE_ACCESS_TOKEN: "sq0" }), "local");

const created = punchTimecardCreateBody({
  locationId: "L1",
  teamMemberId: "TM1",
  startAt: "2026-01-01T15:00:00.000Z",
  idempotencyKey: "key",
});
assert.deepEqual(Object.keys(created.timecard).sort(), ["location_id", "start_at", "team_member_id"]);
assert.equal(JSON.stringify(created).includes("wage"), false);
assert.equal(JSON.stringify(created).includes("hourly"), false);
assert.doesNotThrow(() => assertPunchDoesNotWritePay("/v2/labor/timecards", "POST", JSON.stringify(created)));

const wage = { title: "Print", hourly_rate: { amount: 3200, currency: "USD" }, tip_eligible: false };
const closing = punchTimecardCloseBody(
  {
    team_member_id: "TM1",
    location_id: "L1",
    start_at: "2026-01-01T15:00:00.000Z",
    version: 4,
    wage,
  },
  "2026-01-01T16:00:00.000Z",
);
assert.equal(closing.timecard.status, "CLOSED");
assert.equal((closing.timecard.wage as typeof wage).hourly_rate.amount, 3200);
assert.equal(closing.timecard.wage, wage, "close echoes Square's wage object and does not build a new one");
const bare = punchTimecardCloseBody(
  { team_member_id: "TM1", location_id: "L1", start_at: "2026-01-01T15:00:00.000Z", version: 1 },
  "2026-01-01T16:00:00.000Z",
);
assert.equal("wage" in bare.timecard, false);

assert.throws(
  () => assertPunchDoesNotWritePay("/v2/labor/timecards", "POST", JSON.stringify({ timecard: { wage } })),
  /never writes a wage/,
);
assert.throws(
  () => assertPunchDoesNotWritePay("/v2/team-members/TM1/wage-setting", "PUT", "{}"),
  /never changes pay settings/,
);
assert.doesNotThrow(() =>
  assertPunchDoesNotWritePay("/v2/labor/timecards/card", "PUT", JSON.stringify(closing)),
);

function clientSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return clientSource(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [readFileSync(path, "utf8")] : [];
  });
}

const client = clientSource(join(process.cwd(), "client/src")).join("\n");
assert.equal(client.includes("SQUARE_ACCESS_TOKEN"), false);
assert.equal(client.includes("SQUARE_LABOR_PUNCHES"), false);
assert.equal(client.includes("wage-setting"), false);

console.log("punch book ok");
