import { randomUUID } from "node:crypto";
import { closePunchTimecard, openPunchTimecard } from "./square";

export interface PunchSink {
  readonly mode: "local" | "square";
  clockIn(person: { id: string; name: string }): Promise<{ timecardId: string }>;
  clockOut(timecardId: string): Promise<void>;
}

/** Append-only local punch. No Square call, no wage. */
export class LocalPunchSink implements PunchSink {
  readonly mode = "local" as const;

  async clockIn(): Promise<{ timecardId: string }> {
    return { timecardId: `local_${randomUUID()}` };
  }

  async clockOut(): Promise<void> {}
}

/** Square Labor timecards. Used only when SQUARE_LABOR_PUNCHES is on. */
export class SquarePunchSink implements PunchSink {
  readonly mode = "square" as const;

  async clockIn(person: { id: string; name: string }): Promise<{ timecardId: string }> {
    return { timecardId: await openPunchTimecard(person.id) };
  }

  async clockOut(timecardId: string): Promise<void> {
    if (timecardId.startsWith("local_")) return;
    await closePunchTimecard(timecardId);
  }
}

export function punchSinkMode(env: NodeJS.ProcessEnv = process.env): "local" | "square" {
  const flag = (env.SQUARE_LABOR_PUNCHES ?? "").trim().toLowerCase();
  const on = flag === "1" || flag === "true" || flag === "on";
  return on && env.SQUARE_ACCESS_TOKEN?.trim() ? "square" : "local";
}

export function createPunchSink(env: NodeJS.ProcessEnv = process.env): PunchSink {
  return punchSinkMode(env) === "square" ? new SquarePunchSink() : new LocalPunchSink();
}
