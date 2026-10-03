import { earnEngine } from "../clock/engine";
import { log } from "../vite";
import { squareConfigured, squareFetch } from "./client";
import {
  hourlyRateCents,
  snapshotFromInvoice,
  snapshotFromWebhook,
  type WageSetting,
} from "./parse";

let timer: ReturnType<typeof setInterval> | null = null;
let locationId: string | null = null;
let teamMemberId: string | null = null;

export function startSquareSync() {
  if (timer || !squareConfigured()) return;
  const run = () => {
    void pollSquare().catch((err) => {
      const message = err instanceof Error ? err.message : "sync failed";
      log(message, "square");
    });
  };
  timer = setInterval(run, 15_000);
  run();
}

export function applySquareWebhook(body: unknown): { sale: boolean; points: boolean } {
  const snapshot = snapshotFromWebhook(body);
  if (!snapshot) return { sale: false, points: false };
  return earnEngine.ingestSquareInvoice(snapshot);
}

async function pollSquare() {
  await syncWage();
  await syncInvoices();
}

async function syncWage() {
  const id = await resolveTeamMember();
  if (!id) return;

  const member = await squareFetch<{
    team_member?: { wage_setting?: WageSetting };
  }>(`/v2/team-members/${encodeURIComponent(id)}`);

  let wage = member.team_member?.wage_setting;
  if (!hourlyRateCents(wage)) {
    const extra = await squareFetch<{ wage_setting?: WageSetting }>(
      `/v2/team-members/${encodeURIComponent(id)}/wage-setting`,
    );
    wage = extra.wage_setting ?? wage;
  }

  const cents = hourlyRateCents(wage);
  if (cents) earnEngine.applyWage(cents);
}

async function resolveTeamMember(): Promise<string | null> {
  if (teamMemberId) return teamMemberId;
  if (process.env.SQUARE_TEAM_MEMBER_ID) {
    teamMemberId = process.env.SQUARE_TEAM_MEMBER_ID;
    return teamMemberId;
  }

  const body = await squareFetch<{
    team_members?: Array<{ id?: string; is_owner?: boolean }>;
  }>("/v2/team-members/search", {
    method: "POST",
    body: JSON.stringify({
      query: { filter: { status: "ACTIVE" } },
      limit: 25,
    }),
  });

  const members = body.team_members ?? [];
  const owner = members.find((member) => member.is_owner && member.id) ?? members.find((member) => member.id);
  teamMemberId = owner?.id ?? null;
  return teamMemberId;
}

async function syncInvoices() {
  const location = await resolveLocation();
  if (!location) return;

  const body = await squareFetch<{ invoices?: unknown[] }>("/v2/invoices/search", {
    method: "POST",
    body: JSON.stringify({
      query: {
        filter: { location_ids: [location] },
        sort: { field: "INVOICE_SORT_DATE", order: "DESC" },
      },
      limit: 50,
    }),
  });

  const bootstrapping = !earnEngine.isSquareBootstrapped();
  for (const raw of body.invoices ?? []) {
    const snapshot = snapshotFromInvoice(raw);
    if (!snapshot) continue;
    if (bootstrapping) earnEngine.markSquareInvoiceSeen(snapshot);
    else earnEngine.ingestSquareInvoice(snapshot);
  }
  if (bootstrapping) earnEngine.markSquareBootstrapped();
}

async function resolveLocation(): Promise<string | null> {
  if (locationId) return locationId;
  if (process.env.SQUARE_LOCATION_ID) {
    locationId = process.env.SQUARE_LOCATION_ID;
    return locationId;
  }

  const body = await squareFetch<{
    locations?: Array<{ id?: string; status?: string }>;
  }>("/v2/locations");
  const locations = body.locations ?? [];
  const active = locations.find((location) => location.status === "ACTIVE" && location.id);
  locationId = active?.id ?? locations.find((location) => location.id)?.id ?? null;
  return locationId;
}
