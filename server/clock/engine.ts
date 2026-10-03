import {
  DEFAULT_CONFIG,
  DEFAULT_SESSION,
  INPUT_WEIGHTS,
  type AppConfig,
  type AppState,
  type InputType,
  type PrintEvent,
  type Session,
  type SquareLink,
} from "@shared/schema";
import type { InvoiceSnapshot } from "../square/parse";
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
export class EarnEngine {
  config: AppConfig = { ...DEFAULT_CONFIG };
  session: Session = { ...DEFAULT_SESSION };
  events: PrintEvent[] = [];
  square: SquareLink = { connected: false, source: "demo" };
  private adapter: ClockAdapter = createClockAdapter(this.config.clockSource);
  private timer: ReturnType<typeof setInterval> | null = null;
  private seenExternal = new Set<string>();

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
    this.config = next;
  }

  getState(): AppState {
    const t = now();
    const { accruedOutputCents, msToNextPrint, inputMs } = this.derive(t);
    return {
      config: this.config,
      square: { ...this.square },
      session: { ...this.session },
      events: this.events.slice(0, 40),
      accruedOutputCents,
      inputMs,
      msToNextPrint,
      serverNow: t,
    };
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
    this.events = [];
    return this.getState();
  }

  /** Square wage becomes the rate the strip accrues at. */
  applyWage(cents: number) {
    if (!Number.isInteger(cents) || cents <= 0) return;
    this.square = { connected: true, source: "square" };
    if (this.config.hourlyOutputCents !== cents) {
      this.config = { ...this.config, hourlyOutputCents: cents };
    }
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
    if (snapshot.sent) this.seenExternal.add(`msg:${snapshot.id}`);
    if (snapshot.collected) this.seenExternal.add(`sale:${snapshot.id}`);
  }

  private awardMessage(id: string): boolean {
    const key = `msg:${id}`;
    if (this.seenExternal.has(key)) return false;
    this.seenExternal.add(key);
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
    this.seenExternal.add(key);
    this.session = {
      ...this.session,
      collectedCents: this.session.collectedCents + Math.max(0, cents),
    };
    const name = title?.trim();
    const short = name && name.length > 22 ? `${name.slice(0, 21)}…` : name;
    this.pushEvent(
      makeEvent({
        kind: "sale",
        outputCents: cents,
        inputUnits: 0,
        label: short ? `+$${formatDollars(cents)} ${short}` : `+$${formatDollars(cents)}`,
      }),
    );
    return true;
  }

  private tick() {
    if (!this.session.clockedIn || !this.session.hourSegmentStartedAt) return;
    const t = now();
    const elapsed = t - this.session.hourSegmentStartedAt;
    if (elapsed < this.config.hourDurationMs) return;

    const hours = Math.floor(elapsed / this.config.hourDurationMs);
    for (let i = 0; i < hours; i++) {
      this.printHour(t);
    }
    this.session.hourSegmentStartedAt += hours * this.config.hourDurationMs;
  }

  private printHour(at: number) {
    const amount = this.config.hourlyOutputCents;
    this.session = {
      ...this.session,
      outputCents: this.session.outputCents + amount,
      hoursPrinted: this.session.hoursPrinted + 1,
    };
    this.pushEvent(
      makeEvent({
        kind: "hour_print",
        outputCents: amount,
        inputUnits: 0,
        label: `+$${formatDollars(amount)}`,
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
    this.pushEvent(
      makeEvent({
        kind: "hour_print",
        outputCents: accruedOutputCents,
        inputUnits: 0,
        label: `+$${formatDollars(accruedOutputCents)}`,
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
  }
}

export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return String(dollars);
  return dollars.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export const earnEngine = new EarnEngine();
