import {
  DEFAULT_CONFIG,
  DEFAULT_SESSION,
  INPUT_WEIGHTS,
  type AppConfig,
  type AppState,
  type InputType,
  type PrintEvent,
  type Session,
} from "@shared/schema";
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
  private adapter: ClockAdapter = createClockAdapter(this.config.clockSource);
  private timer: ReturnType<typeof setInterval> | null = null;

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
