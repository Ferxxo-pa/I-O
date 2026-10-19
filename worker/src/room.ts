import { SHOP_ZONE, zonedParts } from "../../shared/fight.ts";
import { DEFAULT_DAY, shopDateStart } from "../../shared/presence.ts";
import {
  autoCloseMoment,
  canonicalOpenId,
  dueAutoClose,
  ledgerKey,
  needsNewTimecard,
  planRemoteTimecard,
  shouldCloseMissing,
  timecardFromWebhook,
  wageWriteBlocked,
  type RemoteCard,
  type ShiftLike,
} from "../../shared/cloud/clockPlan.ts";
import { planPhone, type PhoneResponse, type PhoneSignal } from "../../shared/cloud/phonePlan.ts";
import type { WatchPerson } from "../../shared/cloud/watch.ts";
import { snapshotFromWebhook } from "../../server/square/parse.ts";
import type { Env } from "./env.ts";
import {
  audit,
  companyById,
  deviceOf,
  ledgerIds,
  peopleOf,
  personOf,
  punchesOf,
  rememberSeen,
  saveShift,
  saveWatch,
  seenBody,
  sessionsOf,
  watchOf,
  type PersonRow,
} from "./db.ts";

const SQUARE = "https://connect.squareup.com";
const QUIET_MS = 15 * 60 * 1000;
const PHONE_MAX_AGE_MS = 10 * 60 * 1000;
const PHONE_DEDUPE_MS = 2 * 60 * 1000;
const MAX_FUTURE_MS = 15_000;
const COLLECT_MARGIN_MS = 2 * 60 * 60 * 1000;
const STATIONARY_MS = 14 * 60 * 60 * 1000;

type CardRow = { timecard_id: string; person_id: string; open: number; started_at: number };

export class CompanyRoom {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.handle(request));
  }

  private async handle(request: Request): Promise<Response> {
    const body = (await request.json()) as { op: string; companyId: string; at: number } & Record<string, unknown>;
    const companyId = body.companyId;
    const at = body.at;
    try {
      if (body.op === "clock-in") {
        const state = await this.clockIn(companyId, String(body.personId), at, (body.source as ShiftLike["source"]) ?? "manual");
        return json({ ok: true, state });
      }
      if (body.op === "clock-out") {
        await this.clockOut(companyId, String(body.personId), at, (body.review as ShiftLike["review"]) ?? null, (body.flag as string) ?? null);
        return json({ ok: true });
      }
      if (body.op === "phone") {
        const result = await this.phone(companyId, body as never, at);
        return json(result);
      }
      if (body.op === "webhook") {
        const result = await this.webhook(companyId, body.payload, at);
        return json(result);
      }
      if (body.op === "reconcile") {
        const result = await this.reconcile(companyId, at);
        return json(result);
      }
      if (body.op === "autoclose") {
        const closed = await this.autoClose(companyId, at);
        return json({ ok: true, closed });
      }
      return json({ ok: false, message: "Unknown op" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clock failed";
      await audit(this.env.DB, { companyId, at, action: "clock_error", actor: "anon", ok: false });
      return json({ ok: false, message }, 400);
    }
  }

  private async clockIn(companyId: string, personId: string, at: number, source: ShiftLike["source"]): Promise<ShiftLike> {
    const person = await personOf(this.env.DB, companyId, personId);
    if (!person || person.status !== "active") throw new Error("That person is not on this business");
    const shifts = await sessionsOf(this.env.DB, companyId);
    const existing = shifts.find((shift) => shift.personId === personId);
    const squareId = person.square_team_member_id || person.id;
    const remote = await this.openCards(companyId, squareId, at);
    const remoteIds = remote.map((card) => card.timecardId);
    let timecardId = existing?.timecardId ?? null;
    if (needsNewTimecard({ clockedIn: Boolean(existing?.clockedIn), localTimecardId: timecardId, remoteOpenIds: remoteIds })) {
      timecardId = await this.createCard(companyId, squareId, at, person);
    } else {
      timecardId = canonicalOpenId(remote.map((card) => ({ id: card.timecardId, startedAt: card.startedAt }))) ?? timecardId;
    }
    const shift: ShiftLike = {
      personId,
      name: person.name,
      hourlyCents: person.hourly_cents,
      clockedIn: true,
      clockedInAt: existing?.clockedIn ? existing.clockedInAt : at,
      hourSegmentStartedAt: existing?.clockedIn ? existing.hourSegmentStartedAt : at,
      outputCents: existing?.outputCents ?? 0,
      timecardId,
      holdAt: null,
      managedBy: null,
      source: existing?.source ?? source,
      review: null,
    };
    await saveShift(this.env.DB, companyId, shift);
    await audit(this.env.DB, { companyId, at, action: existing?.clockedIn ? "clock_seen" : "clock_in", actor: source === "manual" ? "pin" : "phone", ok: true });
    return shift;
  }

  private async clockOut(
    companyId: string,
    personId: string,
    at: number,
    review: ShiftLike["review"],
    flag: string | null,
  ): Promise<void> {
    const shifts = await sessionsOf(this.env.DB, companyId);
    const existing = shifts.find((shift) => shift.personId === personId);
    if (!existing?.clockedIn) return;
    if (existing.timecardId) await this.closeCard(companyId, existing.timecardId, at);
    await saveShift(this.env.DB, companyId, {
      ...existing,
      clockedIn: false,
      clockedInAt: null,
      hourSegmentStartedAt: null,
      timecardId: null,
      holdAt: null,
      review,
    });
    const person = await personOf(this.env.DB, companyId, personId);
    await this.env.DB.prepare(
      `INSERT INTO punches (company_id, id, person_id, person_name, type, ts, source, accepted, reason, received_at, closes_day, flag)
       VALUES (?1, ?2, ?3, ?4, 'leave', ?5, ?6, 1, NULL, ?5, 1, ?7)`,
    )
      .bind(companyId, crypto.randomUUID(), personId, person?.name ?? existing.name, at, existing.source ?? "manual", flag)
      .run();
    await audit(this.env.DB, { companyId, at, action: flag === "auto_closed" ? "auto_close" : "clock_out", actor: flag ? "cron" : "pin", ok: true });
  }

  private async phone(
    companyId: string,
    body: { deviceId: string; personId: string; signal: PhoneSignal },
    now: number,
  ): Promise<{ status: number; body: PhoneResponse | { message: string } }> {
    const signal = body.signal;
    const at = signal.ts ?? now;
    const bucket = Math.floor(at / PHONE_DEDUPE_MS);
    const eventKey = signal.eventId ? `phone:${body.deviceId}:evt:${signal.eventId}:${at}` : null;
    const replayKey = eventKey ?? `phone:${body.deviceId}:${signal.trigger}:${signal.event}:${bucket}`;
    const prior = await seenBody(this.env.DB, companyId, replayKey);
    if (prior) {
      const stored = JSON.parse(prior.body) as PhoneResponse;
      return { status: prior.status, body: { ...stored, duplicate: true } };
    }
    const device = await deviceOf(this.env.DB, companyId, body.deviceId);
    const person = await personOf(this.env.DB, companyId, body.personId);
    const watch = person ? await watchOf(this.env.DB, companyId, person.id) : null;
    const shifts = await sessionsOf(this.env.DB, companyId);
    const clockId = person ? person.square_team_member_id || person.id : body.personId;
    const info = shifts.find((shift) => shift.personId === clockId || shift.personId === person?.id);
    const company = await companyById(this.env.DB, companyId);
    const shop = company ? (JSON.parse(company.shop_json) as { openMin?: number; closeMin?: number; timezone?: string }) : {};
    const day = {
      ...DEFAULT_DAY,
      tz: SHOP_ZONE,
      ...(typeof shop.openMin === "number" ? { normalOpenMin: shop.openMin } : {}),
      ...(typeof shop.closeMin === "number" ? { normalCloseMin: shop.closeMin } : {}),
    };
    const plan = planPhone({
      now,
      signal,
      deviceId: body.deviceId,
      personId: body.personId,
      maxAgeMs: PHONE_MAX_AGE_MS,
      maxFutureMs: MAX_FUTURE_MS,
      dedupeMs: PHONE_DEDUPE_MS,
      inWindow: inShopWindow(at, day),
      device: device
        ? {
            id: device.id,
            personId: device.person_id,
            squareTeamMemberId: device.square_team_member_id,
            stationaryAt: device.stationary_at,
            sessionStart: device.session_start,
            squareFlag: device.square_flag,
          }
        : null,
      person: person
        ? {
            id: person.id,
            name: person.name,
            hourlyCents: person.hourly_cents,
            squareTeamMemberId: person.square_team_member_id,
            consent: person.consented_at != null && person.consent_revoked_at == null,
          }
        : null,
      watch,
      shift: info ? { clockedIn: info.clockedIn, holdAt: info.holdAt, managedBy: info.managedBy } : null,
      quietMs: QUIET_MS,
      stationaryMs: STATIONARY_MS,
    });

    if (plan.clockIn) {
      const targetId = person?.id ?? body.personId;
      await this.clockIn(companyId, targetId, plan.clockIn.at, plan.clockIn.source);
      if (plan.clockIn.clearFlag && device) {
        await this.env.DB.prepare("UPDATE devices SET square_flag = NULL WHERE company_id = ?1 AND id = ?2")
          .bind(companyId, device.id)
          .run();
      }
    }
    if (plan.session && device) {
      await this.env.DB.prepare(
        "UPDATE devices SET session_start = ?1, last_seen_at = ?2, stationary_at = ?3 WHERE company_id = ?4 AND id = ?5",
      )
        .bind(plan.session.sessionStart, plan.session.lastSeenAt, plan.session.stationaryAt, companyId, device.id)
        .run();
    }
    if (plan.watch && person) await saveWatch(this.env.DB, companyId, person.id, plan.watch);
    if (plan.journal && person) {
      await this.env.DB.prepare(
        `INSERT INTO punches (company_id, id, person_id, person_name, type, ts, source, accepted, reason, received_at, closes_day, flag)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, ?8, 0, NULL)`,
      )
        .bind(
          companyId,
          crypto.randomUUID(),
          person.id,
          person.name,
          signal.event,
          at,
          signal.trigger === "wifi" ? "phone-wifi" : "phone-geo",
          now,
        )
        .run();
    }
    if (plan.hold && person) {
      const shiftsNow = await sessionsOf(this.env.DB, companyId);
      const open = shiftsNow.find((shift) => shift.personId === person.id && shift.clockedIn);
      if (open) await saveShift(this.env.DB, companyId, { ...open, holdAt: plan.hold.at });
    }
    if (plan.replayKey) await rememberSeen(this.env.DB, companyId, plan.replayKey, plan.status, plan.body, now);
    await audit(this.env.DB, {
      companyId,
      at: now,
      action: `phone_${plan.body.applied}`,
      actor: "phone",
      ok: plan.status < 400,
    });
    return { status: plan.status, body: plan.body };
  }

  private async webhook(companyId: string, payload: unknown, at: number): Promise<{ ok: boolean; timecard: boolean; sale: boolean }> {
    await this.env.DB.prepare("UPDATE companies SET webhook_seen_at = ?1 WHERE id = ?2").bind(at, companyId).run();
    const card = timecardFromWebhook(payload);
    if (card) {
      await this.applyCard(companyId, card, at);
      await audit(this.env.DB, { companyId, at, action: "square_timecard", actor: "square", ok: true });
      return { ok: true, timecard: true, sale: false };
    }
    const snap = snapshotFromWebhook(payload);
    let sale = false;
    if (snap) {
      const seen = await ledgerIds(this.env.DB, companyId);
      if (snap.sent && !seen.has(ledgerKey(snap.id, "sent"))) {
        await this.env.DB.prepare("INSERT INTO ledger (company_id, id, kind, cents, at) VALUES (?1, ?2, 'sent', 0, ?3)")
          .bind(companyId, ledgerKey(snap.id, "sent"), at)
          .run();
      }
      if (snap.collected && snap.centsPaid > 0 && !seen.has(ledgerKey(snap.id, "paid"))) {
        await this.env.DB.prepare("INSERT INTO ledger (company_id, id, kind, cents, at) VALUES (?1, ?2, 'paid', ?3, ?4)")
          .bind(companyId, ledgerKey(snap.id, "paid"), snap.centsPaid, at)
          .run();
        sale = true;
      }
    }
    await audit(this.env.DB, { companyId, at, action: sale ? "square_paid" : "square_event", actor: "square", ok: true });
    return { ok: true, timecard: false, sale };
  }

  private async reconcile(companyId: string, at: number): Promise<{ ok: boolean; open: number }> {
    const people = await peopleOf(this.env.DB, companyId);
    const remote: RemoteCard[] = [];
    for (const person of people) {
      const squareId = person.square_team_member_id || person.id;
      remote.push(...(await this.openCards(companyId, squareId, at)));
    }
    const openIds = new Set(remote.map((card) => card.timecardId));
    for (const card of remote) await this.applyCard(companyId, card, at);
    const shifts = await sessionsOf(this.env.DB, companyId);
    for (const shift of shifts) {
      if (!shouldCloseMissing(shift, openIds, at)) continue;
      await this.applyCard(
        companyId,
        {
          personId: shift.personId,
          name: shift.name,
          hourlyCents: shift.hourlyCents,
          timecardId: shift.timecardId!,
          open: false,
          startedAt: shift.clockedInAt ?? at,
        },
        at,
      );
    }
    await this.pullInvoices(companyId, at);
    await audit(this.env.DB, { companyId, at, action: "reconcile", actor: "cron", ok: true });
    return { ok: true, open: openIds.size };
  }

  private async autoClose(companyId: string, at: number): Promise<number> {
    const company = await companyById(this.env.DB, companyId);
    const shop = company ? (JSON.parse(company.shop_json) as { autoCloseMin?: number; timezone?: string }) : {};
    const closeMin = typeof shop.autoCloseMin === "number" ? shop.autoCloseMin : 19 * 60;
    const tz = "America/Chicago";
    const autoCloseAt = autoCloseMoment(at, closeMin, tz);
    const shifts = await sessionsOf(this.env.DB, companyId);
    let closed = 0;
    for (const shift of shifts) {
      const watch = await watchOf(this.env.DB, companyId, shift.personId);
      const when = dueAutoClose({
        shift,
        watch,
        phase: shift.clockedIn ? (shift.holdAt != null ? "pending" : "working") : "out",
        now: at,
        autoCloseAt,
        quietMs: QUIET_MS,
      });
      if (when == null) continue;
      await this.clockOut(companyId, shift.personId, when, "auto_closed", "auto_closed");
      closed += 1;
    }
    return closed;
  }

  private async applyCard(companyId: string, card: RemoteCard, at: number): Promise<void> {
    const shifts = await sessionsOf(this.env.DB, companyId);
    const people = await peopleOf(this.env.DB, companyId);
    const person = people.find((entry) => entry.id === card.personId || entry.square_team_member_id === card.personId);
    const existing = shifts.find((shift) => shift.personId === (person?.id ?? card.personId) || shift.personId === card.personId);
    const localCard = person ? { ...card, personId: person.id } : card;
      const hourly = person?.hourly_cents ?? (card.hourlyCents || 2000);
      const plan = planRemoteTimecard(existing, localCard, at, hourly);
    if (plan.action === "noop") return;
    if (plan.action === "adopt") {
      const shift = { ...plan.shift, name: person?.name || plan.shift.name, hourlyCents: person?.hourly_cents || plan.shift.hourlyCents };
      await saveShift(this.env.DB, companyId, shift);
      if (plan.emitClockIn) {
        await this.env.DB.prepare(
          `INSERT INTO punches (company_id, id, person_id, person_name, type, ts, source, accepted, reason, received_at, closes_day, flag)
           VALUES (?1, ?2, ?3, ?4, 'arrive', ?5, 'square', 1, NULL, ?6, 0, NULL)`,
        )
          .bind(companyId, crypto.randomUUID(), shift.personId, shift.name, plan.at, at)
          .run();
      }
      return;
    }
    if (existing?.clockedIn) await this.clockOut(companyId, existing.personId, plan.at, existing.review, null);
  }

  private async openCards(companyId: string, squareId: string, at: number): Promise<RemoteCard[]> {
    if (this.env.IO_TEST === "1") {
      const rows = await this.env.DB.prepare(
        "SELECT timecard_id, person_id, open, started_at FROM square_cards WHERE company_id = ?1 AND person_id = ?2 AND open = 1",
      )
        .bind(companyId, squareId)
        .all<CardRow>();
      await this.logSquare(companyId, "POST", "/v2/labor/timecards/search", at);
      return (rows.results ?? []).map((row) => ({
        personId: row.person_id,
        name: "Square",
        hourlyCents: 0,
        timecardId: row.timecard_id,
        open: true,
        startedAt: row.started_at,
      }));
    }
    const token = await this.token(companyId);
    if (!token) return [];
    const body = await this.square(companyId, token, "POST", "/v2/labor/timecards/search", {
      query: { filter: { team_member_id: squareId, status: "OPEN" } },
    }, at);
    const cards = (body as { timecards?: Array<{ id?: string; team_member_id?: string; start_at?: string; status?: string; wage?: { title?: string; hourly_rate?: { amount?: number } } }> }).timecards ?? [];
    return cards
      .filter((card) => card.id && card.team_member_id)
      .map((card) => ({
        personId: card.team_member_id!,
        name: card.wage?.title || "Square",
        hourlyCents: card.wage?.hourly_rate?.amount ?? 0,
        timecardId: card.id!,
        open: card.status ? card.status === "OPEN" : true,
        startedAt: card.start_at ? Date.parse(card.start_at) : at,
      }));
  }

  private async createCard(companyId: string, squareId: string, at: number, person: PersonRow): Promise<string> {
    if (this.env.IO_TEST === "1") {
      const id = `tc_${crypto.randomUUID().slice(0, 8)}`;
      await this.env.DB.prepare(
        "INSERT INTO square_cards (company_id, timecard_id, person_id, open, started_at) VALUES (?1, ?2, ?3, 1, ?4)",
      )
        .bind(companyId, id, squareId, at)
        .run();
      await this.logSquare(companyId, "POST", "/v2/labor/timecards", at);
      return id;
    }
    const token = await this.token(companyId);
    if (!token) return `local_${crypto.randomUUID().slice(0, 8)}`;
    const company = await companyById(this.env.DB, companyId);
    const created = await this.square(companyId, token, "POST", "/v2/labor/timecards", {
      idempotency_key: `clock:${companyId}:${squareId}:${new Date(at).toISOString().slice(0, 10)}`,
      timecard: {
        location_id: company?.location_id ?? "local",
        team_member_id: squareId,
        start_at: new Date(at).toISOString(),
        wage: {
          title: "Hourly",
          hourly_rate: { amount: person.hourly_cents, currency: "USD" },
          tip_eligible: false,
        },
      },
    }, at);
    const id = (created as { timecard?: { id?: string } }).timecard?.id;
    if (!id) throw new Error("Square did not open a timecard");
    return id;
  }

  private async closeCard(companyId: string, timecardId: string, at: number): Promise<void> {
    if (timecardId.startsWith("local_")) return;
    if (this.env.IO_TEST === "1") {
      await this.env.DB.prepare("UPDATE square_cards SET open = 0 WHERE company_id = ?1 AND timecard_id = ?2")
        .bind(companyId, timecardId)
        .run();
      await this.logSquare(companyId, "PUT", `/v2/labor/timecards/${timecardId}`, at);
      return;
    }
    const token = await this.token(companyId);
    if (!token) return;
    const current = await this.square(companyId, token, "GET", `/v2/labor/timecards/${encodeURIComponent(timecardId)}`, undefined, at);
    const card = (current as { timecard?: { version?: number; start_at?: string; team_member_id?: string; location_id?: string; wage?: unknown; breaks?: unknown[] } }).timecard;
    if (!card) return;
    await this.square(companyId, token, "PUT", `/v2/labor/timecards/${encodeURIComponent(timecardId)}`, {
      timecard: { ...card, end_at: new Date(at).toISOString(), status: "CLOSED" },
    }, at);
  }

  private async pullInvoices(companyId: string, at: number): Promise<void> {
    if (this.env.IO_TEST === "1") return;
    const token = await this.token(companyId);
    const company = await companyById(this.env.DB, companyId);
    if (!token || !company) return;
    const body = await this.square(companyId, token, "POST", "/v2/invoices/search", {
      query: { filter: { location_ids: [company.location_id] }, sort: { field: "INVOICE_SORT_DATE", order: "DESC" } },
      limit: 50,
    }, at);
    const invoices = (body as { invoices?: unknown[] }).invoices ?? [];
    for (const invoice of invoices) {
      const snap = snapshotFromWebhook({ type: "invoice.updated", data: { object: { invoice } } });
      if (!snap) continue;
      await this.webhook(companyId, { type: snap.collected ? "invoice.payment_made" : "invoice.published", data: { object: { invoice } } }, at);
    }
  }

  private async token(companyId: string): Promise<string | null> {
    const { openSecret, importAesKey, keyFromBase64 } = await import("../../shared/cloud/secrets.ts");
    const company = await companyById(this.env.DB, companyId);
    if (company?.square_token_enc && this.env.TOKEN_KEY) {
      const key = await importAesKey(keyFromBase64(this.env.TOKEN_KEY));
      return openSecret(key, company.square_token_enc);
    }
    return this.env.SQUARE_ACCESS_TOKEN?.trim() || null;
  }

  private async square(companyId: string, token: string, method: string, path: string, payload: unknown, at: number): Promise<unknown> {
    if (wageWriteBlocked(method, path)) throw new Error("Presence never writes a wage");
    await this.logSquare(companyId, method, path, at);
    const res = await fetch(`${SQUARE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Square-Version": "2026-09-16",
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { errors?: Array<{ detail?: string }> };
    if (!res.ok) throw new Error(body.errors?.[0]?.detail || "Square request failed");
    return body;
  }

  private async logSquare(companyId: string, method: string, path: string, at: number): Promise<void> {
    if (wageWriteBlocked(method, path)) throw new Error("Presence never writes a wage");
    await this.env.DB.prepare("INSERT INTO square_log (company_id, method, path, at) VALUES (?1, ?2, ?3, ?4)")
      .bind(companyId, method, path, at)
      .run();
  }
}

function inShopWindow(ts: number, day: typeof DEFAULT_DAY): boolean {
  if (!Number.isFinite(ts)) return false;
  const date = zonedParts(ts, day.tz).key;
  const start = shopDateStart(date, day.tz);
  const marginMin = Math.round(COLLECT_MARGIN_MS / 60_000);
  const open = start + (day.normalOpenMin - marginMin) * 60_000;
  const close = start + (day.normalCloseMin + marginMin) * 60_000;
  return ts >= open && ts <= close;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type { WatchPerson };
