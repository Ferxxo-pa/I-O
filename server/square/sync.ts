import { earnEngine } from "../clock/engine";
import { log } from "../vite";
import { squareConfigured, squareFetch } from "./client";
import { squareLocationId } from "./location";
import {
  hourlyRateCents,
  snapshotFromInvoice,
  snapshotFromWebhook,
  type WageSetting,
} from "./parse";

let timer: ReturnType<typeof setInterval> | null = null;
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

export async function squarePayRoster(): Promise<
  Array<{ id: string; name: string; hourlyCents: number | null }> | null
> {
  if (!squareConfigured()) return null;

  const members: Array<{
    id?: string;
    given_name?: string;
    family_name?: string;
    status?: string;
  }> = [];
  let cursor: string | undefined;
  do {
    const body = await squareFetch<{
      team_members?: Array<{
        id?: string;
        given_name?: string;
        family_name?: string;
        status?: string;
      }>;
      cursor?: string;
    }>("/v2/team-members/search", {
      method: "POST",
      body: JSON.stringify({
        query: { filter: { status: "ACTIVE" } },
        limit: 25,
        cursor,
      }),
    });
    members.push(...(body.team_members ?? []));
    cursor = body.cursor || undefined;
  } while (cursor);

  const people = [];
  for (const member of members) {
    if (!member.id) continue;
    let hourlyCents: number | null = null;
    try {
      const extra = await squareFetch<{ wage_setting?: WageSetting }>(
        `/v2/team-members/${encodeURIComponent(member.id)}/wage-setting`,
      );
      hourlyCents = hourlyRateCents(extra.wage_setting);
    } catch {
      hourlyCents = null;
    }
    const name = [member.given_name, member.family_name].filter(Boolean).join(" ") || "Team";
    people.push({ id: member.id, name, hourlyCents });
  }
  return people;
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
  const location = await squareLocationId();
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

