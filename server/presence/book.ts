import { randomUUID } from "node:crypto";
import { zonedParts } from "@shared/fight";
import {
  SHOP_PRESENCE,
  dayLabel,
  deriveDay,
  presenceReasonText,
  presenceStreak,
  presenceWeek,
  shopWorkedDates,
  type DayConfig,
  type DayPhase,
  type PersonDay,
  type PresenceDot,
  type PresenceView,
  type PunchRecord,
  type PunchType,
} from "@shared/presence";

export type PunchEffect = "clock_in" | "break" | "return" | "close" | "pending" | "none";
import type { FenceConfig } from "./geo";
import { judgeFix } from "./geo";
import {
  applyStep,
  blankLink,
  mirrorMode,
  nextMirrorStep,
  runMirrorStep,
  type MirrorLink,
  type MirrorTransport,
  type PlannedCall,
  type SquarePerson,
} from "./square";

export type ClockSignal = {
  personId: string;
  name: string;
  phase: DayPhase;
  leaveTs: number | null;
  closedAt: number | null;
};

export type Correction = {
  id: string;
  personId: string;
  personName: string;
  leaveTs: number;
  status: "pending" | "approved" | "denied";
  requestedAt: number;
  resolvedAt: number | null;
};

type Fix = { lat: number; lng: number; accuracy: number; capturedAt: number };

export type PunchInput = {
  person: { id: string; name: string };
  claimedPersonId: string | null;
  type: PunchType;
  fix: Fix | null;
  source: string;
  desk: boolean;
};

function effectOf(before: PersonDay, after: PersonDay, accepted: boolean): PunchEffect {
  if (!accepted) return "none";
  if (before.clockInTs == null && after.clockInTs != null) return "clock_in";
  if (after.phase === "closed" && before.phase !== "closed") return "close";
  if (after.phase === "break" && before.phase !== "break") return "break";
  if (after.phase === "working" && (before.phase === "break" || before.phase === "pending")) return "return";
  if (after.phase === "pending" && before.phase !== "pending") return "pending";
  return "none";
}

export class PresenceBook {
  private records: PunchRecord[];
  private corrections: Correction[];
  private links: MirrorLink[];
  private inflight = new Set<string>();

  constructor(
    private readonly opts: {
      config: DayConfig;
      fence: FenceConfig;
      now: () => number;
      records: PunchRecord[];
      corrections: Correction[];
      links: MirrorLink[];
      squarePeople: SquarePerson[];
      locationId: string;
      append: (record: PunchRecord) => void;
      appendCorrection: (row: Correction) => void;
      saveLink: (link: MirrorLink) => void;
      transport: () => MirrorTransport;
    },
  ) {
    this.records = opts.records.slice();
    this.corrections = opts.corrections.slice();
    this.links = opts.links.map((link) => ({ ...link }));
  }

  config(): DayConfig {
    return this.opts.config;
  }

  list(): PunchRecord[] {
    return this.records.slice();
  }

  correctionList(): Correction[] {
    return this.foldCorrections();
  }

  day(personId: string, now = this.opts.now()): PersonDay {
    return deriveDay(this.accepted(personId), this.opts.config, now);
  }

  async punch(input: PunchInput): Promise<{
    record: PunchRecord;
    effect: PunchEffect;
    day: PersonDay;
  }> {
    if (this.inflight.has(input.person.id)) throw new Error("Punch already in progress");
    this.inflight.add(input.person.id);
    try {
      return await this.decide(input);
    } finally {
      this.inflight.delete(input.person.id);
    }
  }

  requestCorrection(person: { id: string; name: string }, leaveTs: number, now = this.opts.now()): Correction {
    const day = this.day(person.id, now);
    if (day.clockInTs == null || day.phase === "closed" || day.phase === "out") {
      throw new Error("No open day to close");
    }
    if (!Number.isFinite(leaveTs) || leaveTs < day.clockInTs || leaveTs > now) {
      throw new Error("That time isn't in today's shift");
    }
    const date = zonedParts(leaveTs, this.opts.config.tz).key;
    if (date !== day.date) throw new Error("That time isn't in today's shift");
    const row: Correction = {
      id: randomUUID(),
      personId: person.id,
      personName: person.name,
      leaveTs,
      status: "pending",
      requestedAt: now,
      resolvedAt: null,
    };
    this.opts.appendCorrection(row);
    this.corrections.push(row);
    return row;
  }

  async decideCorrection(
    id: string,
    status: "approved" | "denied",
    now = this.opts.now(),
  ): Promise<Correction> {
    const current = this.foldCorrections().find((row) => row.id === id);
    if (!current) throw new Error("That request isn't here");
    if (current.status !== "pending") return current;
    const row: Correction = { ...current, status, resolvedAt: now };
    this.opts.appendCorrection(row);
    this.corrections.push(row);
    if (status === "approved") {
      const day = this.day(current.personId, now);
      if (day.phase !== "closed" && day.clockInTs != null) {
        this.keep(
          { id: current.personId, name: current.personName },
          "leave",
          {
            lat: this.opts.fence.lat,
            lng: this.opts.fence.lng,
            accuracy: 1,
            capturedAt: now,
          },
          current.leaveTs,
          "correction",
          true,
          null,
          0,
          true,
        );
      }
    }
    return row;
  }

  signals(people: Array<{ id: string; name: string }>, now = this.opts.now()): ClockSignal[] {
    return people.map((person) => {
      const day = this.day(person.id, now);
      return {
        personId: person.id,
        name: person.name,
        phase: day.phase,
        leaveTs: day.leaveTs,
        closedAt: day.closedAt,
      };
    });
  }

  /** Catch up Square with accepted punches. One step per person per call. */
  async mirror(peopleIds: string[], now = this.opts.now()): Promise<PlannedCall[]> {
    const planned: PlannedCall[] = [];
    for (const personId of peopleIds) {
      const day = this.day(personId, now);
      const square = this.opts.squarePeople.find((entry) => entry.personId === personId) ?? null;
      let link = this.links.find((entry) => entry.personId === personId && entry.date === day.date) ?? blankLink(personId, day.date);
      if (link.errorAt && now - link.errorAt < 30_000) continue;
      const step = nextMirrorStep(day, link, square, this.opts.locationId || "local");
      if (!step) continue;
      try {
        const result = await runMirrorStep(step, link, this.opts.transport());
        link = result.link;
        planned.push(result.planned);
      } catch {
        link = { ...link, errorAt: now };
      }
      this.putLink(link);
    }
    return planned;
  }

  view(
    people: Array<{ id: string; name: string }>,
    viewerId: string | null,
    now = this.opts.now(),
  ): PresenceView {
    const config = this.opts.config;
    const date = zonedParts(now, config.tz).key;
    const worked = shopWorkedDates(this.records, config, now);
    const dots = people.map((person) => this.dot(person, now));
    const you = viewerId ? (dots.find((dot) => dot.personId === viewerId) ?? null) : null;
    return {
      tz: config.tz,
      now,
      date,
      dots,
      streakDays: presenceStreak({ today: date, worked, openWeekdays: config.openWeekdays, tz: config.tz }),
      week: presenceWeek({ today: date, worked, openWeekdays: config.openWeekdays, tz: config.tz }),
      you,
      squareMode: this.opts.transport().mode,
      shop: { label: SHOP_PRESENCE.label, address: SHOP_PRESENCE.address },
    };
  }

  private async decide(input: PunchInput): Promise<{
    record: PunchRecord;
    effect: PunchEffect;
    day: PersonDay;
  }> {
    const now = this.opts.now();
    const before = this.day(input.person.id, now);
    if (input.claimedPersonId && input.claimedPersonId !== input.person.id) {
      const record = this.store(input, now, false, "wrong_person", input.fix, 0);
      return { record, effect: "none", day: before };
    }

    let fix = input.fix;
    let desk = false;
    if (!fix && input.desk && input.type === "arrive") {
      fix = {
        lat: this.opts.fence.lat,
        lng: this.opts.fence.lng,
        accuracy: 1,
        capturedAt: now,
      };
      desk = true;
    }
    if (!fix) {
      const reason = input.source === "here" ? "desk_required" : "missing_fix";
      const record = this.store(input, now, false, reason, null, 0);
      return { record, effect: "none", day: before };
    }

    const judged = desk
      ? { accepted: true as const, distanceM: 0, reason: null }
      : judgeFix(fix, this.opts.fence, now);
    if (!judged.accepted) {
      const record = this.store(input, now, false, judged.reason, fix, judged.distanceM);
      return { record, effect: "none", day: before };
    }
    if (before.phase === "closed") {
      const record = this.store(input, now, false, "day_closed", fix, judged.distanceM);
      return { record, effect: "none", day: before };
    }

    const record = this.keep(input.person, input.type, fix, now, input.source, true, null, judged.distanceM, false);
    const after = this.day(input.person.id, now);
    return { record, effect: effectOf(before, after, true), day: after };
  }

  private keep(
    person: { id: string; name: string },
    type: PunchType,
    fix: Fix,
    ts: number,
    source: string,
    accepted: boolean,
    reason: string | null,
    distanceM: number,
    closesDay: boolean,
  ): PunchRecord {
    return this.store(
      { person, claimedPersonId: null, type, fix, source, desk: false },
      ts,
      accepted,
      reason,
      fix,
      distanceM,
      closesDay,
    );
  }

  private store(
    input: PunchInput,
    ts: number,
    accepted: boolean,
    reason: string | null,
    fix: Fix | null,
    distanceM: number,
    closesDay = false,
  ): PunchRecord {
    const record: PunchRecord = {
      id: randomUUID(),
      personId: input.person.id,
      personName: input.person.name,
      type: input.type,
      ts,
      lat: fix?.lat ?? 0,
      lng: fix?.lng ?? 0,
      accuracy: fix?.accuracy ?? 0,
      source: input.source,
      accepted,
      reason,
      receivedAt: this.opts.now(),
      closesDay,
      distanceM,
    };
    this.opts.append(record);
    this.records.push(record);
    return record;
  }

  private accepted(personId: string) {
    return this.records
      .filter((row) => row.accepted && row.personId === personId)
      .map((row) => ({ type: row.type, ts: row.ts, closesDay: row.closesDay }));
  }

  private dot(person: { id: string; name: string }, now: number): PresenceDot {
    const day = this.day(person.id, now);
    const copy = dayLabel(day);
    const last = [...this.records].reverse().find((row) => row.personId === person.id) ?? null;
    return {
      personId: person.id,
      name: person.name,
      phase: day.phase,
      present: day.present,
      label: copy.label,
      detail: copy.detail,
      lastAccepted: last ? last.accepted : null,
      lastMessage: last && !last.accepted ? presenceReasonText(last.reason) : null,
      lastTs: last ? last.ts : null,
    };
  }

  private foldCorrections(): Correction[] {
    const byId = new Map<string, Correction>();
    for (const row of this.corrections) byId.set(row.id, row);
    return Array.from(byId.values()).reverse();
  }

  private putLink(link: MirrorLink) {
    const index = this.links.findIndex((entry) => entry.personId === link.personId && entry.date === link.date);
    if (index === -1) this.links.push(link);
    else this.links[index] = link;
    this.opts.saveLink(link);
  }
}

export function squareMode(): "dry_run" | "live" {
  return mirrorMode();
}
