import type { ShiftLike } from "../../shared/cloud/clockPlan.ts";
import type { WatchPerson } from "../../shared/cloud/watch.ts";
import { sha256Hex } from "../../shared/cloud/hmac.ts";

export type CompanyRow = {
  id: string;
  name: string | null;
  code: string | null;
  location_id: string;
  owner_key_hash: string | null;
  pin_hash: string | null;
  shop_json: string;
  fight_json: string | null;
  square_token_enc: string | null;
  square_webhook_enc: string | null;
  webhook_url: string | null;
  webhook_seen_at: number | null;
  created_at: number;
};

export type PersonRow = {
  company_id: string;
  id: string;
  name: string;
  points: number;
  made_cents: number;
  hourly_cents: number;
  status: string;
  consented_at: number | null;
  consent_revoked_at: number | null;
  consent_note: string | null;
  square_team_member_id: string | null;
  square_location_id: string | null;
};

export type DeviceRow = {
  company_id: string;
  id: string;
  person_id: string;
  token_hash: string;
  square_team_member_id: string;
  session_start: number | null;
  last_seen_at: number | null;
  stationary_at: number | null;
  square_flag: string | null;
  revoked_at: number | null;
};

export function tokenHash(token: string): string {
  return sha256Hex(token);
}

export async function companyById(db: D1Database, id: string): Promise<CompanyRow | null> {
  return db.prepare("SELECT * FROM companies WHERE id = ?1").bind(id).first<CompanyRow>();
}

export async function companyByCode(db: D1Database, code: string): Promise<CompanyRow | null> {
  return db.prepare("SELECT * FROM companies WHERE code = ?1").bind(code).first<CompanyRow>();
}

export async function companyByOwner(db: D1Database, hash: string): Promise<CompanyRow | null> {
  return db.prepare("SELECT * FROM companies WHERE owner_key_hash = ?1").bind(hash).first<CompanyRow>();
}

export async function peopleOf(db: D1Database, companyId: string): Promise<PersonRow[]> {
  const rows = await db
    .prepare("SELECT * FROM people WHERE company_id = ?1 AND status = 'active' ORDER BY name")
    .bind(companyId)
    .all<PersonRow>();
  return rows.results ?? [];
}

export async function personOf(db: D1Database, companyId: string, id: string): Promise<PersonRow | null> {
  return db.prepare("SELECT * FROM people WHERE company_id = ?1 AND id = ?2").bind(companyId, id).first<PersonRow>();
}

export async function sessionsOf(db: D1Database, companyId: string): Promise<ShiftLike[]> {
  const rows = await db.prepare("SELECT * FROM sessions WHERE company_id = ?1").bind(companyId).all<SessionRow>();
  return (rows.results ?? []).map(sessionToShift);
}

type SessionRow = {
  person_id: string;
  name: string;
  hourly_cents: number;
  clocked_in: number;
  clocked_in_at: number | null;
  hour_started_at: number | null;
  output_cents: number;
  timecard_id: string | null;
  hold_at: number | null;
  source: ShiftLike["source"];
  review: ShiftLike["review"];
  managed_by: ShiftLike["managedBy"];
};

export function sessionToShift(row: SessionRow): ShiftLike {
  return {
    personId: row.person_id,
    name: row.name,
    hourlyCents: row.hourly_cents,
    clockedIn: row.clocked_in === 1,
    clockedInAt: row.clocked_in_at,
    hourSegmentStartedAt: row.hour_started_at,
    outputCents: row.output_cents,
    timecardId: row.timecard_id,
    holdAt: row.hold_at,
    managedBy: row.managed_by,
    source: row.source,
    review: row.review,
  };
}

export async function saveShift(db: D1Database, companyId: string, shift: ShiftLike): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (
        company_id, person_id, name, hourly_cents, clocked_in, clocked_in_at, hour_started_at,
        output_cents, timecard_id, hold_at, source, review, managed_by
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
      ON CONFLICT(company_id, person_id) DO UPDATE SET
        name = excluded.name,
        hourly_cents = excluded.hourly_cents,
        clocked_in = excluded.clocked_in,
        clocked_in_at = excluded.clocked_in_at,
        hour_started_at = excluded.hour_started_at,
        output_cents = excluded.output_cents,
        timecard_id = excluded.timecard_id,
        hold_at = excluded.hold_at,
        source = excluded.source,
        review = excluded.review,
        managed_by = excluded.managed_by`,
    )
    .bind(
      companyId,
      shift.personId,
      shift.name,
      shift.hourlyCents,
      shift.clockedIn ? 1 : 0,
      shift.clockedInAt,
      shift.hourSegmentStartedAt,
      shift.outputCents,
      shift.timecardId,
      shift.holdAt,
      shift.source,
      shift.review,
      shift.managedBy,
    )
    .run();
}

export async function deviceByHash(db: D1Database, hash: string): Promise<DeviceRow | null> {
  return db
    .prepare("SELECT * FROM devices WHERE token_hash = ?1 AND revoked_at IS NULL")
    .bind(hash)
    .first<DeviceRow>();
}

export async function deviceOf(db: D1Database, companyId: string, id: string): Promise<DeviceRow | null> {
  return db
    .prepare("SELECT * FROM devices WHERE company_id = ?1 AND id = ?2 AND revoked_at IS NULL")
    .bind(companyId, id)
    .first<DeviceRow>();
}

export async function watchOf(db: D1Database, companyId: string, personId: string): Promise<WatchPerson | null> {
  const row = await db
    .prepare("SELECT watch_json FROM watches WHERE company_id = ?1 AND person_id = ?2")
    .bind(companyId, personId)
    .first<{ watch_json: string }>();
  if (!row) return null;
  return JSON.parse(row.watch_json) as WatchPerson;
}

export async function saveWatch(db: D1Database, companyId: string, personId: string, watch: WatchPerson): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watches (company_id, person_id, watch_json) VALUES (?1, ?2, ?3)
       ON CONFLICT(company_id, person_id) DO UPDATE SET watch_json = excluded.watch_json`,
    )
    .bind(companyId, personId, JSON.stringify(watch))
    .run();
}

export async function seenBody(db: D1Database, companyId: string, key: string): Promise<{ status: number; body: string } | null> {
  return db
    .prepare("SELECT status, body FROM seen WHERE company_id = ?1 AND event_key = ?2")
    .bind(companyId, key)
    .first<{ status: number; body: string }>();
}

export async function rememberSeen(
  db: D1Database,
  companyId: string,
  key: string,
  status: number,
  body: unknown,
  at: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO seen (company_id, event_key, status, body, at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(company_id, event_key) DO NOTHING`,
    )
    .bind(companyId, key, status, JSON.stringify(body), at)
    .run();
}

export async function audit(
  db: D1Database,
  row: { companyId: string | null; at: number; action: string; actor: string; ok: boolean },
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO audit (id, company_id, at, action, actor, ok) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, row.companyId, row.at, row.action, row.actor, row.ok ? 1 : 0)
    .run();
}

export async function limited(db: D1Database, key: string, limit: number, now: number): Promise<boolean> {
  const since = now - 60_000;
  await db.prepare("DELETE FROM rate_hits WHERE key = ?1 AND ts < ?2").bind(key, since).run();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM rate_hits WHERE key = ?1").bind(key).first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) return true;
  await db.prepare("INSERT INTO rate_hits (key, ts) VALUES (?1, ?2)").bind(key, now).run();
  return false;
}

export async function ledgerCents(db: D1Database, companyId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(cents), 0) AS n FROM ledger WHERE company_id = ?1 AND kind = 'paid'")
    .bind(companyId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function ledgerIds(db: D1Database, companyId: string): Promise<Set<string>> {
  const rows = await db.prepare("SELECT id FROM ledger WHERE company_id = ?1").bind(companyId).all<{ id: string }>();
  return new Set((rows.results ?? []).map((row) => row.id));
}

export async function punchesOf(db: D1Database, companyId: string) {
  const rows = await db
    .prepare("SELECT person_id, type, ts, accepted, closes_day FROM punches WHERE company_id = ?1")
    .bind(companyId)
    .all<{ person_id: string; type: "arrive" | "leave"; ts: number; accepted: number; closes_day: number }>();
  return (rows.results ?? []).map((row) => ({
    personId: row.person_id,
    type: row.type,
    ts: row.ts,
    accepted: row.accepted === 1,
    closesDay: row.closes_day === 1,
  }));
}
