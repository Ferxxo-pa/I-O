import { randomUUID } from "node:crypto";
import { squareFetch } from "./client";
import { squareLocationId } from "./location";
import { primaryJobWage, type JobWage, type WageSetting } from "./parse";

export type RemoteTimecard = {
  personId: string;
  name: string;
  hourlyCents: number;
  timecardId: string;
  open: boolean;
  startedAt: number;
};

type SquareTimecard = {
  id?: string;
  team_member_id?: string;
  location_id?: string;
  start_at?: string;
  end_at?: string;
  status?: string;
  version?: number;
  wage?: {
    title?: string;
    hourly_rate?: { amount?: number; currency?: string };
    tip_eligible?: boolean;
  };
  breaks?: SquareBreak[];
};

type SquareBreak = {
  id?: string;
  start_at?: string;
  end_at?: string;
  break_type_id?: string;
  name?: string;
  expected_duration?: string;
  is_paid?: boolean;
};

export function timecardCreateBody(input: {
  locationId: string;
  teamMemberId: string;
  startAt: string;
  wage: JobWage;
  idempotencyKey: string;
}) {
  return {
    idempotency_key: input.idempotencyKey,
    timecard: {
      location_id: input.locationId,
      team_member_id: input.teamMemberId,
      start_at: input.startAt,
      wage: {
        title: input.wage.title,
        hourly_rate: { amount: input.wage.hourlyCents, currency: input.wage.currency },
        tip_eligible: input.wage.tipEligible,
      },
    },
  };
}

export function timecardCloseBody(card: SquareTimecard, endAt: string) {
  const breaks = card.breaks?.map((entry) => (entry.end_at ? entry : { ...entry, end_at: endAt }));
  return {
    timecard: {
      team_member_id: card.team_member_id,
      location_id: card.location_id,
      start_at: card.start_at,
      end_at: endAt,
      wage: card.wage,
      breaks,
      status: "CLOSED",
      version: card.version,
    },
  };
}

export function timecardFromWebhook(body: unknown): RemoteTimecard | null {
  if (!body || typeof body !== "object") return null;
  const type = (body as { type?: string }).type ?? "";
  if (!type.startsWith("labor.timecard.")) return null;
  const data = (body as { data?: { object?: { timecard?: SquareTimecard } & SquareTimecard } }).data;
  const card = data?.object?.timecard ?? (data?.object?.id ? data.object : undefined);
  if (!card?.id || !card.team_member_id) return null;
  const open = card.status ? card.status === "OPEN" : !card.end_at;
  const started = card.start_at ? Date.parse(card.start_at) : Date.now();
  return {
    personId: card.team_member_id,
    name: card.wage?.title || "Square",
    hourlyCents: card.wage?.hourly_rate?.amount ?? 0,
    timecardId: card.id,
    open,
    startedAt: Number.isFinite(started) ? started : Date.now(),
  };
}

export async function openTimecard(teamMemberId: string, hourlyCents: number): Promise<string> {
  const existing = await findOpenTimecard(teamMemberId);
  if (existing) return existing;

  const locationId = await locationForMember(teamMemberId);
  const wage = await wageForMember(teamMemberId, hourlyCents);
  const body = await squareFetch<{ timecard?: { id?: string } }>("/v2/labor/timecards", {
    method: "POST",
    body: JSON.stringify(
      timecardCreateBody({
        locationId,
        teamMemberId,
        startAt: new Date().toISOString(),
        wage,
        idempotencyKey: randomUUID(),
      }),
    ),
  });
  const id = body.timecard?.id;
  if (!id) throw new Error("Square did not open a timecard");
  return id;
}

/** Open Square timecards, so a clock-in from Square itself joins the book without a webhook. */
export async function listOpenTimecards(): Promise<RemoteTimecard[]> {
  const locationId = await squareLocationId();
  const cards: SquareTimecard[] = [];
  let cursor: string | undefined;
  do {
    const body = await squareFetch<{ timecards?: SquareTimecard[]; cursor?: string }>(
      "/v2/labor/timecards/search",
      {
        method: "POST",
        body: JSON.stringify({
          query: {
            filter: {
              status: "OPEN",
              ...(locationId ? { location_ids: [locationId] } : {}),
            },
          },
          limit: 50,
          cursor,
        }),
      },
    );
    cards.push(...(body.timecards ?? []));
    cursor = body.cursor || undefined;
  } while (cursor);

  return cards.flatMap((card) => {
    if (!card.id || !card.team_member_id) return [];
    const started = card.start_at ? Date.parse(card.start_at) : Date.now();
    return [
      {
        personId: card.team_member_id,
        name: card.wage?.title || "Square",
        hourlyCents: card.wage?.hourly_rate?.amount ?? 0,
        timecardId: card.id,
        open: true,
        startedAt: Number.isFinite(started) ? started : Date.now(),
      },
    ];
  });
}

async function wageForMember(teamMemberId: string, fallbackCents: number): Promise<JobWage> {
  try {
    const extra = await squareFetch<{ wage_setting?: WageSetting }>(
      `/v2/team-members/${encodeURIComponent(teamMemberId)}/wage-setting`,
    );
    const job = primaryJobWage(extra.wage_setting);
    if (job) return job;
  } catch {
    // The rate already chosen for this person is enough to record the timecard.
  }
  return { title: "Hourly", hourlyCents: fallbackCents, tipEligible: false, currency: "USD" };
}

async function locationForMember(teamMemberId: string): Promise<string> {
  try {
    const body = await squareFetch<{
      team_member?: { assigned_locations?: { location_ids?: string[] } };
    }>(`/v2/team-members/${encodeURIComponent(teamMemberId)}`);
    const assigned = body.team_member?.assigned_locations?.location_ids?.find((id) => id);
    if (assigned) return assigned;
  } catch {
    // Fall through to the business location.
  }
  const locationId = await squareLocationId();
  if (!locationId) throw new Error("Square has no location for this business");
  return locationId;
}

export async function closeTimecard(id: string): Promise<void> {
  const current = await squareFetch<{ timecard?: SquareTimecard }>(
    `/v2/labor/timecards/${encodeURIComponent(id)}`,
  );
  const card = current.timecard;
  if (!card || card.version === undefined) throw new Error("Square timecard is missing");
  if (card.status === "CLOSED" || card.end_at) return;

  await squareFetch(`/v2/labor/timecards/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(timecardCloseBody(card, new Date().toISOString())),
  });
}

async function findOpenTimecard(teamMemberId: string): Promise<string | null> {
  const body = await squareFetch<{ timecards?: Array<{ id?: string }> }>("/v2/labor/timecards/search", {
    method: "POST",
    body: JSON.stringify({
      query: { filter: { team_member_ids: [teamMemberId], status: "OPEN" } },
      limit: 1,
    }),
  });
  return body.timecards?.[0]?.id ?? null;
}
