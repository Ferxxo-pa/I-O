import type { ClockSource } from "@shared/schema";

/**
 * Clock adapters — I/O doesn't care who owns the shift.
 * Local: you tap the strip.
 * Square: Labor Timecards own clock-in later.
 */
export interface ShiftSnapshot {
  clockedIn: boolean;
  externalShiftId: string | null;
  employeeName?: string;
}

export interface ClockAdapter {
  readonly source: ClockSource;
  clockIn(): Promise<ShiftSnapshot>;
  clockOut(): Promise<ShiftSnapshot>;
  getStatus(): Promise<ShiftSnapshot>;
}

export class LocalClockAdapter implements ClockAdapter {
  readonly source = "local" as const;
  private shiftId: string | null = null;
  private clockedIn = false;

  async clockIn(): Promise<ShiftSnapshot> {
    this.clockedIn = true;
    this.shiftId = `local_${Date.now()}`;
    return this.snapshot();
  }

  async clockOut(): Promise<ShiftSnapshot> {
    this.clockedIn = false;
    this.shiftId = null;
    return this.snapshot();
  }

  async getStatus(): Promise<ShiftSnapshot> {
    return this.snapshot();
  }

  private snapshot(): ShiftSnapshot {
    return {
      clockedIn: this.clockedIn,
      externalShiftId: this.shiftId,
    };
  }
}

/** Square Labor Timecards — wire OAuth + create/update when ready. */
export class SquareClockAdapter implements ClockAdapter {
  readonly source = "square" as const;

  async clockIn(): Promise<ShiftSnapshot> {
    throw new Error("Square adapter not connected. Use local clockSource.");
  }

  async clockOut(): Promise<ShiftSnapshot> {
    throw new Error("Square adapter not connected. Use local clockSource.");
  }

  async getStatus(): Promise<ShiftSnapshot> {
    return { clockedIn: false, externalShiftId: null };
  }
}

export function createClockAdapter(source: ClockSource): ClockAdapter {
  if (source === "square") return new SquareClockAdapter();
  return new LocalClockAdapter();
}
