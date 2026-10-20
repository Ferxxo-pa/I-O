import { randomUUID } from "node:crypto";
import type { BreakKind, PersonDay } from "@shared/presence";
import { squareFetch } from "../square/client";
import { squareLocationId } from "../square/location";

/**
 * Optional second step after a punch is accepted.
 * Port of the Labor sequence in Ferxxo-pa/square-autoclock clock.py:
 * open a timecard, start a break, end that break, close the timecard.
 * The repo was not readable from this environment, so this follows that
 * sequence against Square Labor timecards. Dry run is the default.
 * Bodies we author never include an hourly rate. Square keeps the wage.
 */

export type SquarePerson = {
  personId: string;
  teamMemberId: string;
  jobId: string | null;
  lunchBreakTypeId: string | null;
  shortBreakTypeId: string | null;
};

export type MirrorLink = {
  personId: string;
  date: string;
  timecardId: string | null;
  breaksStarted: number;
  openBreak: boolean;
  closed: boolean;
  errorAt: number | null;
};

export type MirrorStep =
  | { op: "open"; startAt: string; teamMemberId: string; jobId: string | null; locationId: string }
  | {
      op: "start_break";
      startAt: string;
      endAt: string | null;
      breakTypeId: string | null;
      name: string;
      kind: BreakKind;
    }
  | { op: "end_break"; endAt: string }
  | { op: "close"; endAt: string };

export type PlannedCall = {
  op: MirrorStep["op"];
  method: "POST" | "PUT";
  path: string;
  body: unknown;
};

const WAGE_KEYS = ["hourly_rate", "amount", "currency", "hourly_money"];

export function mirrorMode(env: NodeJS.ProcessEnv = process.env): "dry_run" | "live" {
  const flag = (env.SQUARE_PRESENCE_MIRROR ?? "").trim().toLowerCase();
  const on = flag === "live" || flag === "1" || flag === "true" || flag === "on";
  return on && env.SQUARE_ACCESS_TOKEN?.trim() ? "live" : "dry_run";
}

export function blankLink(personId: string, date: string): MirrorLink {
  return {
    personId,
    date,
    timecardId: null,
    breaksStarted: 0,
    openBreak: false,
    closed: false,
    errorAt: null,
  };
}

export function assertPresenceDoesNotWritePay(path: string, body?: unknown) {
  if (/wage-setting|\/wages\b/i.test(path)) {
    throw new Error("Presence mirror never changes pay settings");
  }
  const flat = JSON.stringify(body ?? {});
  for (const key of WAGE_KEYS) {
    if (flat.includes(`"${key}"`)) throw new Error("Presence mirror never writes a wage");
  }
}

export function presenceOpenBody(input: {
  locationId: string;
  teamMemberId: string;
  jobId: string | null;
  startAt: string;
  idempotencyKey: string;
}) {
  const timecard: Record<string, unknown> = {
    location_id: input.locationId,
    team_member_id: input.teamMemberId,
    start_at: input.startAt,
  };
  if (input.jobId) timecard.wage = { job_id: input.jobId };
  return { idempotency_key: input.idempotencyKey, timecard };
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/** Next Labor call for this day. Null when the mirror already matches the punches. */
export function nextMirrorStep(
  day: PersonDay,
  link: MirrorLink,
  square: SquarePerson | null,
  locationId: string,
): MirrorStep | null {
  if (!square || day.clockInTs == null || day.phase === "out") return null;
  if (!link.timecardId) {
    return {
      op: "open",
      startAt: iso(day.clockInTs),
      teamMemberId: square.teamMemberId,
      jobId: square.jobId,
      locationId,
    };
  }
  if (link.closed) return null;

  if (link.openBreak) {
    const started = day.breaks[link.breaksStarted - 1];
    const end = started?.end ?? (day.phase === "closed" ? day.closedAt : null);
    if (end != null) return { op: "end_break", endAt: iso(end) };
    return null;
  }

  if (link.breaksStarted < day.breaks.length) {
    const next = day.breaks[link.breaksStarted];
    if (!next) return null;
    return {
      op: "start_break",
      startAt: iso(next.start),
      endAt: next.end != null ? iso(next.end) : null,
      breakTypeId: next.kind === "lunch" ? square.lunchBreakTypeId : square.shortBreakTypeId,
      name: next.kind === "lunch" ? "Lunch" : "Break",
      kind: next.kind,
    };
  }

  if (day.phase === "closed" && day.closedAt != null) {
    return { op: "close", endAt: iso(day.closedAt) };
  }
  return null;
}

export function applyStep(link: MirrorLink, step: MirrorStep, timecardId?: string): MirrorLink {
  if (step.op === "open") {
    return { ...link, timecardId: timecardId ?? link.timecardId, errorAt: null };
  }
  if (step.op === "start_break") {
    return {
      ...link,
      breaksStarted: link.breaksStarted + 1,
      openBreak: step.endAt == null,
      errorAt: null,
    };
  }
  if (step.op === "end_break") return { ...link, openBreak: false, errorAt: null };
  return { ...link, closed: true, openBreak: false, errorAt: null };
}

type SquareCard = {
  id?: string;
  team_member_id?: string;
  location_id?: string;
  start_at?: string;
  end_at?: string;
  version?: number;
  wage?: unknown;
  breaks?: Array<Record<string, unknown>>;
};

function echoCard(card: SquareCard, patch: Record<string, unknown>) {
  const timecard: Record<string, unknown> = {
    team_member_id: card.team_member_id,
    location_id: card.location_id,
    start_at: card.start_at,
    version: card.version,
    ...patch,
  };
  if (card.wage !== undefined) timecard.wage = card.wage;
  return { timecard };
}

function breakEntry(step: Extract<MirrorStep, { op: "start_break" }>) {
  const entry: Record<string, unknown> = {
    start_at: step.startAt,
    name: step.name,
    expected_duration: step.kind === "lunch" ? "PT30M" : "PT10M",
    is_paid: false,
  };
  if (step.endAt) entry.end_at = step.endAt;
  if (step.breakTypeId) entry.break_type_id = step.breakTypeId;
  return entry;
}

export function planCall(step: MirrorStep, link: MirrorLink, idempotencyKey: string): PlannedCall {
  if (step.op === "open") {
    return {
      op: "open",
      method: "POST",
      path: "/v2/labor/timecards",
      body: presenceOpenBody({
        locationId: step.locationId,
        teamMemberId: step.teamMemberId,
        jobId: step.jobId,
        startAt: step.startAt,
        idempotencyKey,
      }),
    };
  }
  const id = link.timecardId ?? "pending";
  if (step.op === "start_break") {
    return {
      op: "start_break",
      method: "PUT",
      path: `/v2/labor/timecards/${encodeURIComponent(id)}`,
      body: {
        timecard: {
          breaks: [breakEntry(step)],
        },
      },
    };
  }
  if (step.op === "end_break") {
    return {
      op: "end_break",
      method: "PUT",
      path: `/v2/labor/timecards/${encodeURIComponent(id)}`,
      body: { timecard: { breaks: [{ end_at: step.endAt }] } },
    };
  }
  return {
    op: "close",
    method: "PUT",
    path: `/v2/labor/timecards/${encodeURIComponent(id)}`,
    body: { timecard: { end_at: step.endAt, status: "CLOSED" } },
  };
}

export type MirrorTransport = {
  mode: "dry_run" | "live";
  request: (path: string, method: string, body?: unknown) => Promise<unknown>;
};

/** Run one step. Dry run returns the body and does not call Square. */
export async function runMirrorStep(
  step: MirrorStep,
  link: MirrorLink,
  transport: MirrorTransport,
): Promise<{ link: MirrorLink; planned: PlannedCall }> {
  const planned = planCall(step, link, `presence-${randomUUID()}`);
  assertPresenceDoesNotWritePay(planned.path, planned.body);
  if (transport.mode === "dry_run") {
    const timecardId = step.op === "open" ? `dry_${link.personId}_${link.date}` : undefined;
    return { link: applyStep(link, step, timecardId), planned };
  }

  if (step.op === "open") {
    const created = (await transport.request(planned.path, "POST", planned.body)) as { timecard?: { id?: string } };
    const id = created.timecard?.id;
    if (!id) throw new Error("Square did not open a timecard");
    return { link: applyStep(link, step, id), planned };
  }

  const current = (await transport.request(
    `/v2/labor/timecards/${encodeURIComponent(link.timecardId ?? "")}`,
    "GET",
  )) as { timecard?: SquareCard };
  const card = current.timecard;
  if (!card || card.version === undefined) throw new Error("Square timecard is missing");

  let patch: Record<string, unknown>;
  if (step.op === "start_break") {
    const breaks = [...(card.breaks ?? []), breakEntry(step)];
    patch = { breaks };
  } else if (step.op === "end_break") {
    const breaks = (card.breaks ?? []).map((entry, index, all) =>
      index === all.length - 1 && !entry.end_at ? { ...entry, end_at: step.endAt } : entry,
    );
    patch = { breaks };
  } else {
    const breaks = (card.breaks ?? []).map((entry) => (entry.end_at ? entry : { ...entry, end_at: step.endAt }));
    patch = { end_at: step.endAt, status: "CLOSED", breaks };
  }
  const body = echoCard(card, patch);
  const authored = JSON.stringify(patch);
  for (const key of WAGE_KEYS) {
    if (authored.includes(`"${key}"`)) throw new Error("Presence mirror never writes a wage");
  }
  await transport.request(planned.path, "PUT", body);
  return { link: applyStep(link, step), planned };
}

export function liveTransport(): MirrorTransport {
  return {
    mode: "live",
    request: (path, method, body) =>
      squareFetch(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

export async function presenceLocationId(): Promise<string> {
  const id = (await squareLocationId()) || process.env.SQUARE_LOCATION_ID?.trim() || "";
  if (!id) throw new Error("Square has no location for this business");
  return id;
}
