import { randomUUID } from "node:crypto";
import type { GeoFix, PunchAction, PunchReason, PunchRecord } from "@shared/punch";
import { judgeFix, type FenceConfig } from "./fence";
import type { PunchSink } from "./sink";

export type PunchPerson = { id: string; name: string };

export class PunchBook {
  private records: PunchRecord[];
  private inflight = new Set<string>();

  constructor(
    private readonly opts: {
      fence: FenceConfig;
      sink: PunchSink;
      now: () => number;
      records: PunchRecord[];
      append: (record: PunchRecord) => void;
    },
  ) {
    this.records = opts.records.slice();
  }

  list(): PunchRecord[] {
    return this.records.slice().reverse();
  }

  mode(): "local" | "square" {
    return this.opts.sink.mode;
  }

  status(personId: string): { clockedIn: boolean; clockedInAt: number | null } {
    const open = this.openShift(personId);
    return { clockedIn: Boolean(open), clockedInAt: open?.at ?? null };
  }

  locate(fix: GeoFix) {
    return judgeFix(fix, this.opts.fence, this.opts.now());
  }

  async punch(person: PunchPerson, action: PunchAction, fix: GeoFix): Promise<PunchRecord> {
    if (this.inflight.has(person.id)) {
      throw new Error("Punch already in progress");
    }
    this.inflight.add(person.id);
    try {
      return await this.decide(person, action, fix);
    } finally {
      this.inflight.delete(person.id);
    }
  }

  private async decide(person: PunchPerson, action: PunchAction, fix: GeoFix): Promise<PunchRecord> {
    const at = this.opts.now();
    const fence = judgeFix(fix, this.opts.fence, at);
    if (!fence.accepted) {
      return this.keep(person, action, fix, at, fence.distanceM, false, fence.reason, null);
    }

    const open = this.openShift(person.id);
    if (action === "in" && open) {
      return this.keep(person, action, fix, at, fence.distanceM, false, "already_clocked_in", null);
    }
    if (action === "out" && !open) {
      return this.keep(person, action, fix, at, fence.distanceM, false, "not_clocked_in", null);
    }

    try {
      if (action === "in") {
        const opened = await this.opts.sink.clockIn(person);
        return this.keep(person, action, fix, at, fence.distanceM, true, null, opened.timecardId);
      }
      await this.opts.sink.clockOut(open!.timecardId);
      return this.keep(person, action, fix, at, fence.distanceM, true, null, open!.timecardId);
    } catch (err) {
      if (this.opts.sink.mode !== "square") throw err;
      return this.keep(person, action, fix, at, fence.distanceM, false, "square_failed", null);
    }
  }

  private keep(
    person: PunchPerson,
    action: PunchAction,
    fix: GeoFix,
    at: number,
    distanceM: number,
    accepted: boolean,
    reason: PunchReason | null,
    timecardId: string | null,
  ): PunchRecord {
    const row: PunchRecord = {
      id: randomUUID(),
      personId: person.id,
      personName: person.name,
      action,
      at,
      capturedAt: fix.capturedAt,
      lat: fix.lat,
      lng: fix.lng,
      accuracyM: fix.accuracyM,
      distanceM,
      accepted,
      reason,
      source: this.opts.sink.mode,
      timecardId,
    };
    this.opts.append(row);
    this.records.push(row);
    return row;
  }

  private openShift(personId: string): { timecardId: string; at: number } | null {
    let open: { timecardId: string; at: number } | null = null;
    for (const row of this.records) {
      if (row.personId !== personId || !row.accepted) continue;
      if (row.action === "in" && row.timecardId) open = { timecardId: row.timecardId, at: row.at };
      if (row.action === "out") open = null;
    }
    return open;
  }
}
