import {
  DEFAULT_CONFIG,
  DEFAULT_SESSION,
  INPUT_WEIGHTS,
  type AppConfig,
  type AppState,
  type InputType,
  type PersonShift,
  type PrintEvent,
  type Session,
  type SquareLink,
} from "@shared/schema";
import type { InvoiceSnapshot } from "../square/parse";
import { squareConfigured } from "../square/client";
import { closeTimecard, openTimecard, type RemoteTimecard } from "../square/labor";
import { createClockAdapter, type ClockAdapter } from "./adapters";
import { randomUUID } from "crypto";

function now() {
  return Date.now();
}

function makeEvent(
  partial: Omit<PrintEvent, "id" | "createdAt"> & { createdAt?: number },
): PrintEvent {
  return {
    id: randomUUID(),
    createdAt: partial.createdAt ?? now(),
    ...partial,
  };
}

/**
 * I/O book.
 * Input accrues while clocked in (time) + manual inputs (prompt/email).
 * Output prints on each completed hour segment — the dopamine fill.
 */
export type RateSource = "default" | "manual" | "square";

export type ClockPerson = {
  id: string;
  name: string;
  hourlyCents: number;
};

export type BookSnapshot = {
  config: AppConfig;
  session: Session;
  shifts: PersonShift[];
  seen: string[];
  squareBootstrapped: boolean;
  rateSource: RateSource;
  square: SquareLink;
};

export class EarnEngine {
  config: AppConfig = { ...DEFAULT_CONFIG };
  session: Session = { ...DEFAULT_SESSION };
  private shifts: PersonShift[] = [];
  events: PrintEvent[] = [];
  square: SquareLink = { connected: false, source: "demo" };
  private adapter: ClockAdapter = createClockAdapter(this.config.clockSource);
  private timer: ReturnType<typeof setInterval> | null = null;
  private seenExternal = new Set<string>();
  private seenOrder: string[] = [];
  private squareBootstrapped = false;
  private rateSource: RateSource = "default";
  private onChange: (() => void) | null = null;
  private silent = false;

  setBookListener(fn: () => void) {
    this.onChange = fn;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setConfig(patch: Partial<AppConfig>) {
    const next = { ...this.config, ...patch };
    if (patch.clockSource && patch.clockSource !== this.config.clockSource) {
      this.adapter = createClockAdapter(patch.clockSource);
    }
    if (patch.hourlyOutputCents !== undefined) this.rateSource = "manual";
    this.config = next;
    this.touch();
  }

  hydrate(snapshot: BookSnapshot) {
    this.silent = true;
    try {
      this.config = { ...DEFAULT_CONFIG, ...snapshot.config };
      this.session = { ...DEFAULT_SESSION, ...snapshot.session };
      this.shifts = (snapshot.shifts ?? []).map((shift) => ({ ...shift }));
      this.square = { ...snapshot.square };
      this.rateSource = snapshot.rateSource;
      this.squareBootstrapped = snapshot.squareBootstrapped;
      this.seenOrder = snapshot.seen.slice(-4000);
      this.seenExternal = new Set(this.seenOrder);
      this.events = [];
      this.adapter = createClockAdapter(this.config.clockSource);
    } finally {
      this.silent = false;
    }
  }

  toPersist(): BookSnapshot {
    return {
      config: { ...this.config },
      session: { ...this.session },
      shifts: this.shifts.map((shift) => ({ ...shift })),
      seen: this.seenOrder.slice(),
      squareBootstrapped: this.squareBootstrapped,
      rateSource: this.rateSource,
      square: { ...this.square },
    };
  }

  isSquareBootstrapped(): boolean {
    return this.squareBootstrapped;
  }

  markSquareBootstrapped() {
    if (this.squareBootstrapped) return;
    this.squareBootstrapped = true;
    this.touch();
  }

  getState(viewerId: string | null = null): AppState {
    const t = now();
    const legacy = this.derive(t);
    const you = viewerId ? this.shifts.find((shift) => shift.personId === viewerId) : undefined;
    const accruedOutputCents =
      legacy.accruedOutputCents +
      this.shifts.reduce((sum, shift) => sum + this.shiftAccrual(shift, t), 0);
    const outputCents =
      this.session.outputCents + this.shifts.reduce((sum, shift) => sum + shift.outputCents, 0);
    const viewerClockedIn = viewerId ? Boolean(you?.clockedIn) : this.session.clockedIn;
    return {
      config: this.config,
      square: { ...this.square },
      session: {
        ...this.session,
        outputCents,
        clockedIn: viewerClockedIn,
        clockedInAt: viewerId ? (you?.clockedInAt ?? null) : this.session.clockedInAt,
        hourSegmentStartedAt: viewerId
          ? (you?.hourSegmentStartedAt ?? null)
          : this.session.hourSegmentStartedAt,
        externalShiftId: viewerId ? (you?.timecardId ?? null) : this.session.externalShiftId,
      },
      events: this.events.slice(0, 40),
      accruedOutputCents,
      inputMs: viewerId && you?.clockedInAt ? Math.max(0, t - you.clockedInAt) : legacy.inputMs,
      msToNextPrint: legacy.msToNextPrint,
      serverNow: t,
      you: {
        id: viewerId,
        name: you?.name ?? null,
        clockedIn: viewerClockedIn,
      },
    };
  }

  /**
   * Clock one person in. When Square is connected this opens their timecard.
   * Their wage joins every other open shift on the company total.
   */
  async clockInPerson(person: ClockPerson): Promise<AppState> {
    if (!person.id || !person.name || !Number.isInteger(person.hourlyCents) || person.hourlyCents <= 0) {
      throw new Error("That person is not on this business");
    }
    const existing = this.shifts.find((shift) => shift.personId === person.id);
    let timecardId = existing?.timecardId ?? null;
    if (squareConfigured()) {
      timecardId = await openTimecard(person.id, person.hourlyCents);
    }
    if (existing?.clockedIn) {
      this.upsertShift({
        ...existing,
        name: person.name,
        hourlyCents: person.hourlyCents,
        timecardId: timecardId ?? existing.timecardId,
      });
      return this.getState(person.id);
    }

    const t = now();
    this.upsertShift({
      personId: person.id,
      name: person.name,
      hourlyCents: person.hourlyCents,
      clockedIn: true,
      clockedInAt: t,
      hourSegmentStartedAt: t,
      outputCents: existing?.outputCents ?? 0,
      timecardId,
    });
    this.pushEvent(
      makeEvent({
        kind: "clock_in",
        outputCents: 0,
        inputUnits: 0,
        label: "IN",
        createdAt: t,
      }),
    );
    return this.getState(person.id);
  }

  async clockOutPerson(personId: string): Promise<AppState> {
    const existing = this.shifts.find((shift) => shift.personId === personId);
    if (!existing?.clockedIn) return this.getState(personId);
    if (existing.timecardId && squareConfigured()) {
      await closeTimecard(existing.timecardId);
    }

    const t = now();
    const settled = this.settleShift(existing, t);
    this.upsertShift({
      ...settled,
      clockedIn: false,
      clockedInAt: null,
      hourSegmentStartedAt: null,
      timecardId: null,
    });
    this.pushEvent(
      makeEvent({
        kind: "clock_out",
        outputCents: 0,
        inputUnits: 0,
        label: "OUT",
        createdAt: t,
      }),
    );
    return this.getState(personId);
  }

  /**
   * Drop local shifts whose Square timecard is no longer open.
   * A shift that just opened is left alone so a slow search cannot clock them out.
   */
  closeShiftsExcept(openTimecardIds: Set<string>, at = now()): void {
    for (const shift of [...this.shifts]) {
      if (!shift.clockedIn || !shift.timecardId) continue;
      if (openTimecardIds.has(shift.timecardId)) continue;
      if (shift.clockedInAt && at - shift.clockedInAt < 20_000) continue;
      this.syncRemoteTimecard({
        personId: shift.personId,
        name: shift.name,
        hourlyCents: shift.hourlyCents,
        timecardId: shift.timecardId,
        open: false,
        startedAt: shift.clockedInAt ?? at,
      });
    }
  }

  /** A Square timecard opened or closed somewhere else still joins this book. */
  syncRemoteTimecard(card: RemoteTimecard): void {
    const existing = this.shifts.find((shift) => shift.personId === card.personId);
    if (card.open) {
      if (existing?.clockedIn && existing.timecardId === card.timecardId) return;
      const started = card.startedAt || now();
      const hourly =
        card.hourlyCents > 0
          ? card.hourlyCents
          : (existing?.hourlyCents ?? this.config.hourlyOutputCents);
      this.upsertShift({
        personId: card.personId,
        name: existing?.name || card.name || "Square",
        hourlyCents: hourly,
        clockedIn: true,
        clockedInAt: existing?.clockedIn ? existing.clockedInAt : started,
        hourSegmentStartedAt: existing?.clockedIn ? existing.hourSegmentStartedAt : started,
        outputCents: existing?.outputCents ?? 0,
        timecardId: card.timecardId,
      });
      if (!existing?.clockedIn) {
        this.pushEvent(
          makeEvent({
            kind: "clock_in",
            outputCents: 0,
            inputUnits: 0,
            label: "IN",
            createdAt: started,
          }),
        );
      }
      return;
    }
    if (!existing?.clockedIn) return;
    const t = now();
    const settled = this.settleShift(existing, t);
    this.upsertShift({
      ...settled,
      clockedIn: false,
      clockedInAt: null,
      hourSegmentStartedAt: null,
      timecardId: null,
    });
    this.pushEvent(
      makeEvent({
        kind: "clock_out",
        outputCents: 0,
        inputUnits: 0,
        label: "OUT",
        createdAt: t,
      }),
    );
  }

  async clockIn(): Promise<AppState> {
    if (this.session.clockedIn) return this.getState();

    const shift = await this.adapter.clockIn();
    const t = now();
    this.session = {
      ...this.session,
      clockedIn: true,
      clockedInAt: t,
      hourSegmentStartedAt: t,
      externalShiftId: shift.externalShiftId,
    };

    this.pushEvent(
      makeEvent({
        kind: "clock_in",
        outputCents: 0,
        inputUnits: 0,
        label: "IN",
        createdAt: t,
      }),
    );

    return this.getState();
  }

  async clockOut(): Promise<AppState> {
    if (!this.session.clockedIn) return this.getState();

    this.settlePartial(now());

    await this.adapter.clockOut();
    const t = now();
    this.session = {
      ...this.session,
      clockedIn: false,
      clockedInAt: null,
      hourSegmentStartedAt: null,
      externalShiftId: null,
    };

    this.pushEvent(
      makeEvent({
        kind: "clock_out",
        outputCents: 0,
        inputUnits: 0,
        label: "OUT",
        createdAt: t,
      }),
    );

    return this.getState();
  }

  recordInput(type: InputType): AppState {
    const weight = INPUT_WEIGHTS[type];
    this.session = {
      ...this.session,
      inputUnits: this.session.inputUnits + weight.units,
    };
    this.pushEvent(
      makeEvent({
        kind: "input",
        outputCents: 0,
        inputUnits: weight.units,
        label: `I +${weight.units}`,
        inputType: type,
      }),
    );
    return this.getState();
  }

  reset(): AppState {
    this.session = { ...DEFAULT_SESSION };
    this.shifts = [];
    this.events = [];
    this.touch();
    return this.getState();
  }

  /** A Square wage replaces whatever was typed in. Square is the rate once it is connected. */
  applyWage(cents: number) {
    if (!Number.isInteger(cents) || cents <= 0) return;
    const changed =
      this.square.source !== "square" ||
      this.rateSource !== "square" ||
      this.config.hourlyOutputCents !== cents;
    this.square = { connected: true, source: "square" };
    this.rateSource = "square";
    if (this.config.hourlyOutputCents !== cents) {
      this.config = { ...this.config, hourlyOutputCents: cents };
    }
    if (changed) this.touch();
  }

  /**
   * A collected Square invoice prints a sale. A sent invoice awards one point.
   * Personal wages stay on the hour clock — the sale is the shared notification.
   */
  ingestSquareInvoice(snapshot: InvoiceSnapshot): { sale: boolean; points: boolean } {
    const points = snapshot.sent ? this.awardMessage(snapshot.id) : false;
    const sale = snapshot.collected
      ? this.celebrateSale(snapshot.id, snapshot.centsPaid, snapshot.title)
      : false;
    return { sale, points };
  }

  /** Remember invoices that already existed so startup does not replay them. */
  markSquareInvoiceSeen(snapshot: InvoiceSnapshot) {
    if (snapshot.sent) this.remember(`msg:${snapshot.id}`);
    if (snapshot.collected) this.remember(`sale:${snapshot.id}`);
  }

  private awardMessage(id: string): boolean {
    const key = `msg:${id}`;
    if (this.seenExternal.has(key)) return false;
    this.remember(key);
    this.session = {
      ...this.session,
      inputUnits: this.session.inputUnits + 1,
    };
    this.pushEvent(
      makeEvent({
        kind: "input",
        outputCents: 0,
        inputUnits: 1,
        label: "+1",
        inputType: "message",
      }),
    );
    return true;
  }

  private celebrateSale(id: string, cents: number, title?: string): boolean {
    const key = `sale:${id}`;
    if (this.seenExternal.has(key)) return false;
    this.remember(key);
    this.session = {
      ...this.session,
      collectedCents: this.session.collectedCents + Math.max(0, cents),
    };
    const label = signedLabel(cents);
    this.pushEvent(
      makeEvent({
        kind: "sale",
        outputCents: cents,
        inputUnits: 0,
        label,
      }),
    );
    return true;
  }

  private tick() {
    const t = now();
    if (this.session.clockedIn && this.session.hourSegmentStartedAt) {
      const elapsed = t - this.session.hourSegmentStartedAt;
      if (elapsed >= this.config.hourDurationMs) {
        const hours = Math.floor(elapsed / this.config.hourDurationMs);
        for (let i = 0; i < hours; i++) this.printHour(t);
        this.session.hourSegmentStartedAt += hours * this.config.hourDurationMs;
      }
    }

    for (const shift of [...this.shifts]) {
      if (!shift.clockedIn || !shift.hourSegmentStartedAt) continue;
      const elapsed = t - shift.hourSegmentStartedAt;
      if (elapsed < this.config.hourDurationMs) continue;
      const hours = Math.floor(elapsed / this.config.hourDurationMs);
      let next = shift;
      for (let i = 0; i < hours; i++) next = this.printShiftHour(next, t);
      this.upsertShift({
        ...next,
        hourSegmentStartedAt: shift.hourSegmentStartedAt + hours * this.config.hourDurationMs,
      });
    }
  }

  private printShiftHour(shift: PersonShift, at: number): PersonShift {
    const amount = shift.hourlyCents;
    const next = { ...shift, outputCents: shift.outputCents + amount };
    this.pushEvent(
      makeEvent({
        kind: "hour_print",
        outputCents: amount,
        inputUnits: 0,
        label: signedLabel(-amount),
        createdAt: at,
      }),
    );
    return next;
  }

  private settleShift(shift: PersonShift, at: number): PersonShift {
    const accrued = this.shiftAccrual(shift, at);
    if (accrued <= 0) return shift;
    const next = { ...shift, outputCents: shift.outputCents + accrued };
    this.pushEvent(
      makeEvent({
        kind: "hour_print",
        outputCents: accrued,
        inputUnits: 0,
        label: signedLabel(-accrued),
        createdAt: at,
      }),
    );
    return next;
  }

  private shiftAccrual(shift: PersonShift, t: number): number {
    if (!shift.clockedIn || !shift.hourSegmentStartedAt) return 0;
    const elapsed = Math.max(0, t - shift.hourSegmentStartedAt);
    const ratio = Math.min(1, elapsed / this.config.hourDurationMs);
    return Math.floor(shift.hourlyCents * ratio);
  }

  private upsertShift(next: PersonShift) {
    const index = this.shifts.findIndex((shift) => shift.personId === next.personId);
    if (index === -1) this.shifts = [...this.shifts, next];
    else this.shifts = this.shifts.map((shift, i) => (i === index ? next : shift));
  }

  private printHour(at: number) {
    const amount = this.config.hourlyOutputCents;
    this.session = {
      ...this.session,
      outputCents: this.session.outputCents + amount,
      hoursPrinted: this.session.hoursPrinted + 1,
    };
    const label = signedLabel(-amount);
    this.pushEvent(
      makeEvent({
        kind: "hour_print",
        outputCents: amount,
        inputUnits: 0,
        label,
        createdAt: at,
      }),
    );
  }

  private settlePartial(at: number) {
    const { accruedOutputCents } = this.derive(at);
    if (accruedOutputCents <= 0) return;
    this.session = {
      ...this.session,
      outputCents: this.session.outputCents + accruedOutputCents,
    };
    const label = signedLabel(-accruedOutputCents);
    this.pushEvent(
      makeEvent({
        kind: "hour_print",
        outputCents: accruedOutputCents,
        inputUnits: 0,
        label,
        createdAt: at,
      }),
    );
  }

  private derive(t: number): {
    accruedOutputCents: number;
    msToNextPrint: number;
    inputMs: number;
  } {
    if (!this.session.clockedIn || !this.session.hourSegmentStartedAt) {
      return { accruedOutputCents: 0, msToNextPrint: 0, inputMs: 0 };
    }
    const inputMs = Math.max(0, t - (this.session.clockedInAt ?? t));
    const elapsed = Math.max(0, t - this.session.hourSegmentStartedAt);
    const ratio = Math.min(1, elapsed / this.config.hourDurationMs);
    const accruedOutputCents = Math.floor(
      this.config.hourlyOutputCents * ratio,
    );
    const msToNextPrint = Math.max(0, this.config.hourDurationMs - elapsed);
    return { accruedOutputCents, msToNextPrint, inputMs };
  }

  private pushEvent(event: PrintEvent) {
    this.events = [event, ...this.events].slice(0, 100);
    this.touch();
  }

  private remember(key: string) {
    if (this.seenExternal.has(key)) return;
    this.seenExternal.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 4000) {
      const drop = this.seenOrder.splice(0, this.seenOrder.length - 4000);
      for (const id of drop) this.seenExternal.delete(id);
    }
  }

  private touch() {
    if (!this.silent) this.onChange?.();
  }
}

function signedLabel(cents: number): string {
  const body = formatDollars(Math.abs(cents));
  return cents < 0 ? `−$${body}` : `+$${body}`;
}

export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return String(dollars);
  return dollars.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export const earnEngine = new EarnEngine();
