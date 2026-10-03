import { randomUUID } from "node:crypto";
import { squareFetch } from "./client";
import { squareLocationId } from "./location";

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
  };
};

export function timecardCreateBody(input: {
  locationId: string;
  teamMemberId: string;
  startAt: string;
  hourlyCents: number;
  idempotencyKey: string;
}) {
  return {
    idempotency_key: input.idempotencyKey,
    timecard: {
      location_id: input.locationId,
      team_member_id: input.teamMemberId,
      start_at: input.startAt,
      wage: {
        title: "Hourly",
        hourly_rate: { amount: input.hourlyCents, currency: "USD" },
      },
    },
  };
}

export function timecardCloseBody(card: SquareTimecard, endAt: string) {
  return {
    timecard: {
      team_member_id: card.team_member_id,
      location_id: card.location_id,
      start_at: card.start_at,
      end_at: endAt,
      wage: card.wage,
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

  const locationId = await squareLocationId();
  if (!locationId) throw new Error("Square has no location for this business");

  const body = await squareFetch<{ timecard?: { id?: string } }>("/v2/labor/timecards", {
    method: "POST",
    body: JSON.stringify(
      timecardCreateBody({
        locationId,
        teamMemberId,
        startAt: new Date().toISOString(),
        hourlyCents,
        idempotencyKey: randomUUID(),
      }),
    ),
  });
  const id = body.timecard?.id;
  if (!id) throw new Error("Square did not open a timecard");
  return id;
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
