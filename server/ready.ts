import { ownLoginPct, readiness, type ReadinessCheck } from "@shared/ops";
import { backupCheck } from "./backup";
import { webhookNotificationUrl } from "./publicBase";
import { earnEngine } from "./clock/engine";
import { currentScope, getCompany } from "./company";
import { fightBook } from "./fight/book";
import { publicUrlCheck } from "./publicUrl";
import { squareConfigured } from "./square/client";

export type HealthReport = {
  ok: true;
  ready: boolean;
  scope: { companyId: string; locationId: string };
  checks: ReadinessCheck[];
};

/** Process is up when `ok` is true. `ready` is the go-live checklist. */
export async function healthReport(): Promise<HealthReport> {
  const signals = fightBook.signals();
  const people = getCompany().people;
  const roster = people.length;
  const rated = people.filter((person) => person.hourlyCents > 0).length;
  const linkedIds = new Set(earnEngine.linkedPersonIds());
  const linked = people.filter((person) => linkedIds.has(person.id)).length;
  const pct = ownLoginPct(roster, linked);
  const ownLoginDetail = pct == null ? "Add the team" : `${linked} of ${roster} · ${pct}%`;

  const square = squareConfigured();
  const ratesOk = square
    ? earnEngine.rateSourceName() === "square" || (roster > 0 && rated === roster)
    : roster > 0 && rated === roster;
  const rateDetail = square && earnEngine.rateSourceName() === "square"
    ? "Square"
    : roster === 0
      ? "Add the team"
      : `${rated} of ${roster}`;

  const webhookConfigured = Boolean(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY && webhookNotificationUrl());
  const backup = backupCheck();
  const publicUrl = await publicUrlCheck();
  const report = readiness({
    squareToken: square,
    webhookConfigured,
    webhookSeen: signals.webhookSeen,
    pinSet: signals.pinSet,
    rentEntered: signals.rentEntered,
    ratesOk,
    rateDetail,
    ownLoginPct: pct,
    ownLoginDetail,
    backupOk: backup.ok,
    backupDetail: backup.detail,
    backupNote: backup.note,
    publicUrlOk: publicUrl.ok,
    publicUrlDetail: publicUrl.detail,
    publicUrlNote: publicUrl.note,
  });
  return { ok: true, ready: report.ready, scope: currentScope(), checks: report.checks };
}
