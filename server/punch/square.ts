import { randomUUID } from "node:crypto";
import { squareFetch } from "../square/client";
import { squareLocationId } from "../square/location";

type SquareTimecard = {
  id?: string;
  team_member_id?: string;
  location_id?: string;
  start_at?: string;
  end_at?: string;
  status?: string;
  version?: number;
  wage?: unknown;
  breaks?: Array<{ end_at?: string } & Record<string, unknown>>;
};

/**
 * Create body for a shop-clock timecard.
 * Wage is intentionally absent. Square keeps the team member's existing job.
 */
export function punchTimecardCreateBody(input: {
  locationId: string;
  teamMemberId: string;
  startAt: string;
  idempotencyKey: string;
}) {
  return {
    idempotency_key: input.idempotencyKey,
    timecard: {
      location_id: input.locationId,
      team_member_id: input.teamMemberId,
      start_at: input.startAt,
    },
  };
}

/**
 * Close body. If Square already stored a wage, it is copied back unchanged
 * so the update does not clear it. This function never builds an hourly rate.
 */
export function punchTimecardCloseBody(card: SquareTimecard, endAt: string) {
  const timecard: Record<string, unknown> = {
    team_member_id: card.team_member_id,
    location_id: card.location_id,
    start_at: card.start_at,
    end_at: endAt,
    status: "CLOSED",
    version: card.version,
  };
  if (card.breaks) {
    timecard.breaks = card.breaks.map((entry) => (entry.end_at ? entry : { ...entry, end_at: endAt }));
  }
  if (card.wage !== undefined) timecard.wage = card.wage;
  return { timecard };
}

/** Refuse wage-setting and any create that tries to send a wage. */
export function assertPunchDoesNotWritePay(path: string, method: string, body?: string) {
  if (/wage-setting|\/wages\b/i.test(path)) {
    throw new Error("Punch clock never changes pay settings");
  }
  if (method.toUpperCase() === "POST" && body) {
    const parsed = JSON.parse(body) as { timecard?: object };
    if (parsed.timecard && Object.prototype.hasOwnProperty.call(parsed.timecard, "wage")) {
      throw new Error("Punch clock never writes a wage");
    }
  }
}

async function punchFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : undefined;
  assertPunchDoesNotWritePay(path, method, body);
  return squareFetch<T>(path, init);
}

async function findOpenTimecard(teamMemberId: string): Promise<string | null> {
  const body = await punchFetch<{ timecards?: Array<{ id?: string }> }>("/v2/labor/timecards/search", {
    method: "POST",
    body: JSON.stringify({
      query: { filter: { team_member_ids: [teamMemberId], status: "OPEN" } },
      limit: 1,
    }),
  });
  return body.timecards?.[0]?.id ?? null;
}

/** Open a timecard without sending a wage. An already-open card is reused. */
export async function openPunchTimecard(teamMemberId: string): Promise<string> {
  const existing = await findOpenTimecard(teamMemberId);
  if (existing) return existing;

  const locationId = await squareLocationId();
  if (!locationId) throw new Error("Square has no location for this business");

  const created = await punchFetch<{ timecard?: { id?: string } }>("/v2/labor/timecards", {
    method: "POST",
    body: JSON.stringify(
      punchTimecardCreateBody({
        locationId,
        teamMemberId,
        startAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
      }),
    ),
  });
  const id = created.timecard?.id;
  if (!id) throw new Error("Square did not open a timecard");
  return id;
}

/** Close a timecard. The wage object, when present, is the one Square returned. */
export async function closePunchTimecard(id: string): Promise<void> {
  const current = await punchFetch<{ timecard?: SquareTimecard }>(
    `/v2/labor/timecards/${encodeURIComponent(id)}`,
  );
  const card = current.timecard;
  if (!card || card.version === undefined) throw new Error("Square timecard is missing");
  if (card.status === "CLOSED" || card.end_at) return;

  await punchFetch(`/v2/labor/timecards/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(punchTimecardCloseBody(card, new Date().toISOString())),
  });
}
